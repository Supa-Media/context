import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

/**
 * THE TEX ARCHITECTURE LAB'S TOOL STATS (its Tools tab): per tool and per
 * tool action, calls, errors, median time and the reasons calls failed, over
 * a window of days. The gateway reports each finished turn's tool calls
 * through `/gateway/agent-turn`, the failures through `/gateway/tool-failures`,
 * and staff read the joined report.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * ## Sabotage record
 *
 *  1. Count held calls as calls. → "a held call is not a call that ran" fails.
 *  2. Keep any action the gateway sends, without the name check. → "a malformed action is dropped, the turn is kept" fails.
 *  3. Read the window with no lower bound. → "a turn older than the window is not counted" fails.
 *  4. Key by the tool that ran instead of `six`. → "a call made as one of the six is counted under that name…" fails.
 */

const STAFF = "staff@example.invalid";
const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550100";
const DAY = 24 * 60 * 60 * 1000;

type T = ReturnType<typeof setupTest>;

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function texter(t: T, slug = "ada") {
  const userId = await createUser(t, `${slug}@example.invalid`);
  await createWorkspace(t, userId, slug, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone: PHONE });
  await agentPost(t, "/agent-texts/link", { phone: PHONE, code });
  const opened = await agentPost(t, "/agent-texts/session", { phone: PHONE });
  return { accessToken: opened.accessToken as string };
}

async function world(t: T) {
  process.env[ADMIN_EMAILS_ENV_VAR] = STAFF;
  const staff = await createUser(t, STAFF);
  const { accessToken } = await texter(t);
  return { staff, accessToken };
}

const TURN = {
  provider: "builtin",
  model: "@cf/zai-org/glm-4.7-flash",
  outcome: "answered",
  ms: 3_000,
  modelMs: 1_000,
  toolMs: 1_000,
  rounds: 1,
  inputTokens: 100,
  outputTokens: 10,
  trace: [] as Array<Record<string, unknown>>,
};

async function report(t: T, accessToken: string, trace: Array<Record<string, unknown>>) {
  const response = await gatewayPost(t, "/gateway/agent-turn", { accessToken, expectedWorkspaceId: null, ...TURN, trace }, {});
  return JSON.parse(await response.text()) as { recorded: boolean };
}

async function sendFailures(t: T, accessToken: string, failures: Array<Record<string, string>>) {
  const response = await gatewayPost(t, "/gateway/tool-failures", { expectedWorkspaceId: null, accessToken, kind: "one", failures });
  return JSON.parse(await response.text()) as { kept: number };
}

const turns = (t: T) => t.run(async (ctx) => await ctx.db.query("agentTurns").collect());

function stats(t: T, userId: Id<"users">, days?: number) {
  return asUser(t, userId).query(api.functions.texLabToolStats.toolStats, days === undefined ? {} : { days });
}

describe("the Tex Architecture Lab's tool stats", () => {
  test("only staff can read it", async () => {
    const t = setupTest();
    await world(t);
    const someone = await createUser(t, "ben@example.invalid");
    await expect(stats(t, someone)).rejects.toThrow();
  });

  test("calls, errors and median time per tool and per action; a held call is no row and no count", async () => {
    const t = setupTest();
    const { staff, accessToken } = await world(t);
    expect((await report(t, accessToken, [{ kind: "tool", tool: "write", action: "save", ok: true, ms: 400 }, { kind: "tool", tool: "search", ok: true, ms: 100 }, { kind: "tool", tool: "send", action: "text", ok: true, ms: 50, held: true }])).recorded).toBe(true);
    expect((await report(t, accessToken, [{ kind: "tool", tool: "write", action: "save", ok: false, ms: 900 }])).recorded).toBe(true);

    const result = await stats(t, staff);
    expect(result.days).toBe(7);
    expect(result.truncated).toBe(false);
    expect(result.turns).toBe(2);
    expect(result.calls).toBe(3);
    const byKey = Object.fromEntries(result.rows.map((row) => [row.key, row]));
    expect(byKey.write).toMatchObject({ tool: "write", action: null, calls: 2, errors: 1, medianMs: 900 });
    expect(byKey["write.save"]).toMatchObject({ tool: "write", action: "save", calls: 2, errors: 1, medianMs: 900, why: [] });
    expect(byKey.search).toMatchObject({ tool: "search", action: null, calls: 1, errors: 0, medianMs: 100 });
    expect(byKey.send).toBeUndefined();
    expect(byKey["send.text"]).toBeUndefined();
    expect(result.rows.map((row) => row.key)).toEqual(["write", "write.save", "search"]);
  });

  test("a malformed action is dropped and the turn is still kept", async () => {
    const t = setupTest();
    const { accessToken } = await world(t);
    expect((await report(t, accessToken, [{ kind: "tool", tool: "write", action: "Bad Action", ok: true, ms: 5 }])).recorded).toBe(true);
    const [row] = await turns(t);
    expect(row.trace).toEqual([{ kind: "tool", tool: "write", ok: true, ms: 5 }]);
  });

  test("the reasons calls failed come back under the tool's row, most common first", async () => {
    const t = setupTest();
    const { staff, accessToken } = await world(t);
    expect((await report(t, accessToken, [{ kind: "tool", tool: "write", action: "save", ok: false, ms: 20 }])).recorded).toBe(true);
    expect((await sendFailures(t, accessToken, [
      { tool: "write", cause: "refused", why: "No note at <path>." },
      { tool: "write", cause: "refused", why: "No note at <path>." },
      { tool: "write", cause: "threw", why: "The save was stopped." },
    ])).kept).toBe(3);

    const result = await stats(t, staff);
    expect(result.failuresTotal).toBe(3);
    const write = result.rows.find((row) => row.key === "write");
    expect(write?.why).toEqual([
      { why: "No note at <path>.", cause: "refused", count: 2 },
      { why: "The save was stopped.", cause: "threw", count: 1 },
    ]);
    expect(result.rows.find((row) => row.key === "write.save")?.why).toEqual([]);
  });

  test("a call made as one of the six is counted under that name, and its failures find the row", async () => {
    const t = setupTest();
    const { staff, accessToken } = await world(t);
    // `write` `save` runs as `write_note`; `manage` `move` as `move_note`; a six name that is not one is dropped.
    expect((await report(t, accessToken, [
      { kind: "tool", tool: "write_note", six: "write", action: "save", ok: true, ms: 300 },
      { kind: "tool", tool: "move_note", six: "manage", action: "move", ok: false, ms: 80 },
      { kind: "tool", tool: "search_web", six: "nonsense", ok: true, ms: 40 },
    ])).recorded).toBe(true);
    expect((await sendFailures(t, accessToken, [{ tool: "move_note", cause: "refused", why: "No note at <path>." }])).kept).toBe(1);

    const [row] = await turns(t);
    expect(row.trace[2]).toEqual({ kind: "tool", tool: "search_web", ok: true, ms: 40 });
    const byKey = Object.fromEntries((await stats(t, staff)).rows.map((r) => [r.key, r]));
    expect(byKey["write.save"]).toMatchObject({ tool: "write", action: "save", calls: 1 });
    expect(byKey.manage).toMatchObject({ calls: 1, errors: 1, why: [{ why: "No note at <path>.", cause: "refused", count: 1 }] });
    expect(byKey["manage.move"]).toMatchObject({ calls: 1, errors: 1 });
    expect(byKey.search_web).toMatchObject({ calls: 1 });
    expect(byKey.write_note).toBeUndefined();
  });

  test("a turn older than the window is not counted", async () => {
    const t = setupTest();
    const { staff, accessToken } = await world(t);
    expect((await report(t, accessToken, [{ kind: "tool", tool: "search", ok: true, ms: 10 }])).recorded).toBe(true);
    const [old] = await turns(t);
    await t.run(async (ctx) => await ctx.db.patch(old._id, { at: Date.now() - 10 * DAY }));
    expect((await report(t, accessToken, [{ kind: "tool", tool: "search", ok: true, ms: 30 }])).recorded).toBe(true);

    const seven = await stats(t, staff, 7);
    expect(seven.turns).toBe(1);
    expect(seven.rows.find((row) => row.key === "search")).toMatchObject({ calls: 1, medianMs: 30 });
    const thirty = await stats(t, staff, 30);
    expect(thirty.rows.find((row) => row.key === "search")).toMatchObject({ calls: 2, medianMs: 30 });
  });
});
