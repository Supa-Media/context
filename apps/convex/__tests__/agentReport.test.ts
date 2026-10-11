import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { clampAgentDays, percentile } from "../functions/lib/adminFns/agentReport";
import { asUser, createUser, createWorkspace, seedGrant, setupTest } from "./fixtures.helpers";

/**
 * THE AGENT TAB'S REPORT (`functions/lib/adminFns/agentReport.ts`).
 *
 * Staff only, figures over the turn log, and a filter by client and by
 * workspace. The rows are seeded straight into `agentTurns`: how they get
 * there is `agentTurns.test.ts`'s job.
 */

const ADMIN = "staff@example.invalid";
const DAY = 86_400_000;

type T = ReturnType<typeof setupTest>;

async function seedTurn(
  t: T,
  workspaceId: Id<"workspaces">,
  grantId: Id<"oauthGrants">,
  turn: { at: number; ms: number; client?: "texts" | "app"; outcome?: "answered" | "exhausted" | "failed"; tools?: [string, number, boolean][] },
) {
  const tools = turn.tools ?? [];
  await t.run((ctx) =>
    ctx.db.insert("agentTurns", {
      workspaceId,
      grantId,
      client: turn.client ?? "texts",
      provider: "builtin",
      model: "@cf/zai-org/glm-4.7-flash",
      outcome: turn.outcome ?? "answered",
      at: turn.at,
      ms: turn.ms,
      modelMs: turn.ms - tools.reduce((sum, [, ms]) => sum + ms, 0),
      toolMs: tools.reduce((sum, [, ms]) => sum + ms, 0),
      rounds: tools.length + 1,
      inputTokens: 100,
      outputTokens: 10,
      trace: [
        ...tools.map(([tool, ms, ok]) => ({ kind: "tool" as const, tool, ok, ms })),
        { kind: "model" as const, ok: true, ms: 1 },
      ],
    }),
  );
}

async function world(t: T) {
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  const staff = await createUser(t, ADMIN);
  const ada = await createUser(t, "ada@example.invalid");
  const bo = await createUser(t, "bo@example.invalid");
  const adaWs = await createWorkspace(t, ada, "ada", { kind: "personal" });
  const boWs = await createWorkspace(t, bo, "bo", { kind: "personal" });
  const adaGrant = await seedGrant(t, adaWs, ada, "context_texts", "hash-ada");
  const boGrant = await seedGrant(t, boWs, bo, "context_console", "hash-bo");
  return { staff, ada, adaWs, boWs, adaGrant, boGrant };
}

describe("the agent report", () => {
  test("only staff may read it", async () => {
    const t = setupTest();
    const { ada } = await world(t);
    await expect(asUser(t, ada).query(api.functions.admin.agentReport, {})).rejects.toThrow();
    await expect(t.query(api.functions.admin.agentReport, {})).rejects.toThrow();
  });

  test("typical and slowest times, outcomes, tools and the week before", async () => {
    const t = setupTest();
    const { staff, adaWs, boWs, adaGrant, boGrant } = await world(t);
    const now = Date.now();
    for (let i = 1; i <= 20; i += 1) {
      await seedTurn(t, adaWs, adaGrant, { at: now - i * 60_000, ms: i * 1000, tools: [["search_notes", 400, true]] });
    }
    await seedTurn(t, boWs, boGrant, {
      at: now - 2 * DAY,
      ms: 30_000,
      client: "app",
      outcome: "failed",
      tools: [["read_note", 200, false], ["search_web", 900, true]],
    });
    // The week before: two turns, both slower.
    await seedTurn(t, adaWs, adaGrant, { at: now - 8 * DAY, ms: 50_000 });
    await seedTurn(t, adaWs, adaGrant, { at: now - 9 * DAY, ms: 60_000 });
    // Older than both windows: never counted.
    await seedTurn(t, adaWs, adaGrant, { at: now - 20 * DAY, ms: 1 });

    const report = await asUser(t, staff).query(api.functions.admin.agentReport, { days: 7 });
    expect(report.days).toBe(7);
    expect(report.current.turns).toBe(21);
    expect(report.current.workspaces).toBe(2);
    expect(report.current.answered).toBe(20);
    expect(report.current.failed).toBe(1);
    expect(report.current.p50).toBe(11_000);
    expect(report.current.p95).toBe(20_000);
    expect(report.prior).toEqual({ turns: 2, p50: 50_000, p95: 60_000 });
    expect(report.current.toolCalls).toBe(22);
    expect(report.tools.map((tool) => tool.tool)).toEqual(["search_notes", "read_note", "search_web"]);
    expect(report.tools[1]).toMatchObject({ calls: 1, failed: 1 });
    expect(report.buckets).toHaveLength(7);
    expect(report.buckets.reduce((sum, bucket) => sum + bucket.turns, 0)).toBe(21);
    expect(report.recent[0].workspace).toBe("ada");
    expect(report.recent).toHaveLength(21);
    expect(report.recent.find((turn) => turn.client === "app")?.workspace).toBe("bo");

    const texts = await asUser(t, staff).query(api.functions.admin.agentReport, { days: 7, client: "app" });
    expect(texts.current.turns).toBe(1);
    expect(texts.tools.map((tool) => tool.tool)).toEqual(["read_note", "search_web"]);

    const day = await asUser(t, staff).query(api.functions.admin.agentReport, { days: 1 });
    expect(day.buckets).toHaveLength(24);
    expect(day.current.turns).toBe(20);
  });

  test("a workspace filter narrows to it, and a slug that names nothing matches nothing", async () => {
    const t = setupTest();
    const { staff, adaWs, boWs, adaGrant, boGrant } = await world(t);
    const now = Date.now();
    await seedTurn(t, adaWs, adaGrant, { at: now - 1000, ms: 1000 });
    await seedTurn(t, boWs, boGrant, { at: now - 2000, ms: 2000, client: "app" });

    const bo = await asUser(t, staff).query(api.functions.admin.agentReport, { workspace: "@BO" });
    expect(bo.workspace).toBe("bo");
    expect(bo.current.turns).toBe(1);
    expect(bo.recent.map((turn) => turn.workspace)).toEqual(["bo"]);

    const nobody = await asUser(t, staff).query(api.functions.admin.agentReport, { workspace: "nobody" });
    expect(nobody.workspace).toBeNull();
    expect(nobody.current.turns).toBe(0);
    expect(nobody.recent).toEqual([]);
  });

  test("the helpers", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(clampAgentDays(undefined)).toBe(7);
    expect(clampAgentDays(90)).toBe(30);
    expect(clampAgentDays(2)).toBe(1);
  });
});
