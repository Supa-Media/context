import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { MAX_TURNS_READ } from "../functions/lib/adminFns/agentReport";
import { insertTurn } from "../functions/lib/agentTurnMark";
import { AGENT_TURN_RETENTION_MS } from "../functions/agentTurns";
import { asUser, createUser, createWorkspace, seedGrant, setupTest } from "./fixtures.helpers";

/**
 * THE TURN MARKS (`agentTurnMarks`): one small row per turn, so the staff
 * console can count a month of turns. A month of whole turns passed a query's
 * read limit in production (2026-11-14: "Home could not load").
 */

const ADMIN = "staff@example.invalid";
type T = ReturnType<typeof setupTest>;

function turn(workspaceId: Id<"workspaces">, grantId: Id<"oauthGrants">, at: number, tools = 1) {
  return {
    workspaceId,
    grantId,
    client: "texts" as const,
    provider: "builtin",
    model: "fake-model",
    outcome: "answered" as const,
    at,
    ms: 1000,
    modelMs: 600,
    toolMs: 400,
    rounds: tools + 1,
    inputTokens: 1,
    outputTokens: 1,
    trace: [
      ...Array.from({ length: tools }, () => ({ kind: "tool" as const, tool: "search_notes", ok: true, ms: 100 })),
      { kind: "model" as const, ok: true, ms: 600 },
    ],
  };
}

async function world(t: T) {
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  const staff = await createUser(t, ADMIN);
  const ada = await createUser(t, "ada@example.invalid");
  const ws = await createWorkspace(t, ada, "ada", { kind: "personal" });
  const grant = await seedGrant(t, ws, ada, "context_texts", "hash-ada");
  return { staff, ws, grant };
}

describe("turn marks", () => {
  test("a turn is written with its mark, counting its tool calls", async () => {
    const t = setupTest();
    const { ws, grant } = await world(t);
    await t.run((ctx) => insertTurn(ctx, turn(ws, grant, Date.now(), 3)));
    const marks = await t.run((ctx) => ctx.db.query("agentTurnMarks").collect());
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ workspaceId: ws, outcome: "answered", ms: 1000, toolCalls: 3 });
  });

  test("the backfill marks older turns once, however often it runs", async () => {
    const t = setupTest();
    const { ws, grant } = await world(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i += 1) await ctx.db.insert("agentTurns", turn(ws, grant, now - i * 1000, i));
    });
    await t.run((ctx) => insertTurn(ctx, turn(ws, grant, now + 1, 2)));
    await t.mutation(internal.functions.agentTurnMarks.backfill, {});
    await t.finishAllScheduledFunctions(() => {});
    await t.mutation(internal.functions.agentTurnMarks.backfill, {});
    await t.finishAllScheduledFunctions(() => {});
    const marks = await t.run((ctx) => ctx.db.query("agentTurnMarks").collect());
    expect(marks).toHaveLength(6);
    expect(marks.map((mark) => mark.toolCalls).sort()).toEqual([0, 1, 2, 2, 3, 4]);
  });

  test("the retention sweep takes old marks with old turns", async () => {
    const t = setupTest();
    const { ws, grant } = await world(t);
    await t.run((ctx) => insertTurn(ctx, turn(ws, grant, Date.now() - AGENT_TURN_RETENTION_MS - 1000)));
    await t.run((ctx) => insertTurn(ctx, turn(ws, grant, Date.now())));
    await t.mutation(internal.functions.agentTurns.purgeOldAgentTurns, {});
    expect(await t.run((ctx) => ctx.db.query("agentTurnMarks").collect())).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("agentTurns").collect())).toHaveLength(1);
  });

  test("the report counts every marked turn, though it reads only the newest whole", async () => {
    const t = setupTest();
    const { staff, ws, grant } = await world(t);
    const now = Date.now();
    const extra = 50;
    await t.run(async (ctx) => {
      // MAX_TURNS_READ whole turns, and more turns than that marked: the counts must not stop at the whole ones.
      for (let i = 0; i < MAX_TURNS_READ + extra; i += 1) {
        const row = turn(ws, grant, now - (i + 1) * 1000);
        if (i < MAX_TURNS_READ) await insertTurn(ctx, row);
        else
          await ctx.db.insert("agentTurnMarks", {
            turn: await ctx.db.insert("agentTurns", row),
            workspaceId: ws,
            client: "texts",
            provider: "builtin",
            model: "fake-model",
            outcome: "failed",
            at: row.at,
            ms: 1000,
            modelMs: 600,
            toolMs: 400,
            toolCalls: 1,
          });
      }
    });
    const report = await asUser(t, staff).query(api.functions.admin.agentReport, { days: 30 });
    expect(report.current.turns).toBe(MAX_TURNS_READ + extra);
    expect(report.current.failed).toBe(extra);
    expect(report.current.toolCalls).toBe(MAX_TURNS_READ + extra);
    expect(report.toolsFrom).toBe(MAX_TURNS_READ);
    expect(report.truncated).toBe(false);
  });
});
