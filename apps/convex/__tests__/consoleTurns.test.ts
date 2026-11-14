import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { clampConsoleDays, normalizeConsoleQuery } from "../functions/lib/adminFns/consoleTurns";
import { asUser, createUser, createWorkspace, seedGrant, setupTest } from "./fixtures.helpers";

/**
 * THE STAFF CONSOLE'S TURNS PAGE (`functions/lib/adminFns/consoleTurns.ts`).
 *
 * Tex's text turns only, figures over the turn log and the self-review scores,
 * with a filter by trouble and by a search word. Rows are seeded straight into
 * `agentTurns` and `texReviewScores`; how they get there is their own tests'.
 */

const ADMIN = "staff@example.invalid";
const DAY = 86_400_000;
const HOUR = 3_600_000;

type T = ReturnType<typeof setupTest>;

type Turn = {
  at: number;
  ms: number;
  client?: "texts" | "app";
  kind?: "one" | "group" | "job" | "routine" | "app";
  outcome?: "answered" | "exhausted" | "failed";
  tools?: [string, number, boolean][];
};

async function seedTurn(t: T, workspaceId: Id<"workspaces">, grantId: Id<"oauthGrants">, turn: Turn) {
  const tools = turn.tools ?? [];
  const toolMs = tools.reduce((sum, [, ms]) => sum + ms, 0);
  await t.run((ctx) =>
    ctx.db.insert("agentTurns", {
      workspaceId,
      grantId,
      client: turn.client ?? "texts",
      ...(turn.kind === undefined ? {} : { kind: turn.kind }),
      provider: "builtin",
      model: "@cf/zai-org/glm-4.7-flash",
      outcome: turn.outcome ?? "answered",
      at: turn.at,
      ms: turn.ms,
      waitMs: 500,
      modelMs: turn.ms - toolMs,
      toolMs,
      rounds: tools.length + 1,
      inputTokens: 100,
      outputTokens: 10,
      costMicroUsd: 42,
      trace: [
        ...tools.map(([tool, ms, ok]) => ({ kind: "tool" as const, tool, action: "save", ok, ms })),
        { kind: "model" as const, model: "@cf/zai-org/glm-4.7-flash", ok: true, ms: 1 },
      ],
    }),
  );
}

async function seedReview(t: T, at: number, independence: number, signals: string[] = []) {
  await t.run((ctx) =>
    ctx.db.insert("texReviewScores", {
      day: "2026-11-01",
      at,
      kind: "one",
      reason: "ended",
      goal: 8,
      independence,
      turns: 3,
      friendly: 8,
      calm: 8,
      signals,
    }),
  );
}

async function world(t: T) {
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  const staff = await createUser(t, ADMIN);
  const ada = await createUser(t, "ada@example.invalid");
  const bo = await createUser(t, "bo@example.invalid");
  await t.run((ctx) => ctx.db.patch(ada, { name: "Ada Lovelace" }));
  const adaWs = await createWorkspace(t, ada, "ada", { kind: "personal" });
  const boWs = await createWorkspace(t, bo, "bo", { kind: "personal" });
  const adaGrant = await seedGrant(t, adaWs, ada, "context_texts", "hash-ada");
  const boGrant = await seedGrant(t, boWs, bo, "context_console", "hash-bo");
  return { staff, ada, bo, adaWs, boWs, adaGrant, boGrant };
}

describe("the console's turns page", () => {
  test("only staff may read it", async () => {
    const t = setupTest();
    const { ada } = await world(t);
    await expect(asUser(t, ada).query(api.functions.consoleAi.turns, {})).rejects.toThrow();
    await expect(t.query(api.functions.consoleAi.turns, {})).rejects.toThrow();
    // The AI costs page's action checks the same way, before it asks Cloudflare anything.
    await expect(asUser(t, ada).action(api.functions.consoleAi.costs, {})).rejects.toThrow();
    await expect(t.action(api.functions.consoleAi.costs, {})).rejects.toThrow();
  });

  test("only text turns count: jobs, routines and app turns are left out", async () => {
    const t = setupTest();
    const { staff, adaWs, adaGrant } = await world(t);
    const now = Date.now();
    await seedTurn(t, adaWs, adaGrant, { at: now - 1000, ms: 1000, kind: "one" });
    await seedTurn(t, adaWs, adaGrant, { at: now - 2000, ms: 2000, kind: "group" });
    // A row from before kinds were kept counts as a one-to-one text.
    await seedTurn(t, adaWs, adaGrant, { at: now - 3000, ms: 3000 });
    await seedTurn(t, adaWs, adaGrant, { at: now - 4000, ms: 90_000, kind: "job" });
    await seedTurn(t, adaWs, adaGrant, { at: now - 5000, ms: 90_000, kind: "routine" });
    await seedTurn(t, adaWs, adaGrant, { at: now - 6000, ms: 90_000, kind: "app" });
    await seedTurn(t, adaWs, adaGrant, { at: now - 7000, ms: 90_000, client: "app" });

    const page = await asUser(t, staff).query(api.functions.consoleAi.turns, { days: 1 });
    expect(page.days).toBe(1);
    expect(page.turns).toBe(3);
    expect(page.oneToOne).toBe(2);
    expect(page.group).toBe(1);
    expect(page.answeredOne).toBe(2);
    expect(page.p95Ms).toBe(3000);
    expect(page.recentTotal).toBe(3);
    expect(page.recent.map((turn) => turn.ms)).toEqual([1000, 2000, 3000]);
    expect(page.recent.map((turn) => turn.group)).toEqual([false, true, false]);
  });

  test("an unknown window falls back to thirty days", () => {
    expect(clampConsoleDays(undefined)).toBe(30);
    expect(clampConsoleDays(2)).toBe(30);
    expect(clampConsoleDays(90)).toBe(90);
    expect(clampConsoleDays(7)).toBe(7);
  });

  test("the trouble filter keeps only turns that did not answer", async () => {
    const t = setupTest();
    const { staff, adaWs, adaGrant } = await world(t);
    const now = Date.now();
    await seedTurn(t, adaWs, adaGrant, { at: now - 1000, ms: 1000 });
    await seedTurn(t, adaWs, adaGrant, { at: now - 2000, ms: 2000, outcome: "exhausted" });
    await seedTurn(t, adaWs, adaGrant, { at: now - 3000, ms: 3000, outcome: "failed" });

    const all = await asUser(t, staff).query(api.functions.consoleAi.turns, { days: 7 });
    expect(all.recentTotal).toBe(3);
    const trouble = await asUser(t, staff).query(api.functions.consoleAi.turns, { days: 7, end: "trouble" });
    expect(trouble.recentTotal).toBe(2);
    expect(trouble.recent.map((turn) => turn.outcome)).toEqual(["exhausted", "failed"]);
    // The totals are not narrowed by the filter.
    expect(trouble.turns).toBe(3);
  });

  test("the search word matches a workspace slug, and an owner's name", async () => {
    const t = setupTest();
    const { staff, adaWs, boWs, adaGrant, boGrant } = await world(t);
    const now = Date.now();
    await seedTurn(t, adaWs, adaGrant, { at: now - 1000, ms: 1000 });
    await seedTurn(t, boWs, boGrant, { at: now - 2000, ms: 2000 });

    const bySlug = await asUser(t, staff).query(api.functions.consoleAi.turns, { days: 7, q: "  @BO " });
    expect(bySlug.recentTotal).toBe(1);
    expect(bySlug.recent.map((turn) => turn.workspace)).toEqual(["bo"]);

    const byName = await asUser(t, staff).query(api.functions.consoleAi.turns, { days: 7, q: "lovelace" });
    expect(byName.recentTotal).toBe(1);
    expect(byName.recent[0]).toMatchObject({ workspace: "ada", person: "Ada Lovelace" });

    const nobody = await asUser(t, staff).query(api.functions.consoleAi.turns, { days: 7, q: "nobody" });
    expect(nobody.recentTotal).toBe(0);
    expect(nobody.recent).toEqual([]);
    // The totals still count every text turn.
    expect(nobody.turns).toBe(2);
  });

  test("hourly buckets for a one-day window, daily otherwise", async () => {
    const t = setupTest();
    const { staff, adaWs, adaGrant } = await world(t);
    const now = Date.now();
    await seedTurn(t, adaWs, adaGrant, { at: now - 1000, ms: 1000 });
    await seedTurn(t, adaWs, adaGrant, { at: now - 2 * HOUR, ms: 2000 });

    const day = await asUser(t, staff).query(api.functions.consoleAi.turns, { days: 1 });
    expect(day.series).toHaveLength(24);
    expect(day.series[23].label).toMatch(/^\d{2}:00$/);
    expect(day.series.reduce((sum, bucket) => sum + bucket.turns, 0)).toBe(2);

    const week = await asUser(t, staff).query(api.functions.consoleAi.turns, { days: 7 });
    expect(week.series).toHaveLength(7);
    expect(week.series[6].label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(week.series.reduce((sum, bucket) => sum + bucket.turns, 0)).toBe(2);
  });

  test("the prior window's median, null when it has no text turns", async () => {
    const t = setupTest();
    const { staff, adaWs, adaGrant } = await world(t);
    const now = Date.now();
    await seedTurn(t, adaWs, adaGrant, { at: now - 1000, ms: 1000 });
    const none = await asUser(t, staff).query(api.functions.consoleAi.turns, { days: 7 });
    expect(none.priorP50Ms).toBeNull();

    await seedTurn(t, adaWs, adaGrant, { at: now - 8 * DAY, ms: 50_000 });
    await seedTurn(t, adaWs, adaGrant, { at: now - 9 * DAY, ms: 70_000 });
    await seedTurn(t, adaWs, adaGrant, { at: now - 10 * DAY, ms: 1, kind: "job" });
    const some = await asUser(t, staff).query(api.functions.consoleAi.turns, { days: 7 });
    expect(some.priorP50Ms).toBe(50_000);
    expect(some.turns).toBe(1);
  });

  test("the where split: model, tool and other milliseconds", async () => {
    const t = setupTest();
    const { staff, adaWs, adaGrant } = await world(t);
    const now = Date.now();
    // 10_000 ms total: 3_000 in one tool, so 7_000 of model time in the row.
    await seedTurn(t, adaWs, adaGrant, { at: now - 1000, ms: 10_000, tools: [["search_notes", 3000, true]] });
    const page = await asUser(t, staff).query(api.functions.consoleAi.turns, { days: 1 });
    expect(page.where).toEqual({ modelMs: 7000, toolMs: 3000, otherMs: 0 });
  });

  test("troubled share counts a failed tool call, and hand-backs come from reviews", async () => {
    const t = setupTest();
    const { staff, adaWs, adaGrant } = await world(t);
    const now = Date.now();
    await seedTurn(t, adaWs, adaGrant, { at: now - 1000, ms: 1000 });
    // Answered, but its browse failed: troubled.
    await seedTurn(t, adaWs, adaGrant, { at: now - 2000, ms: 2000, tools: [["read_note", 100, false]] });
    await seedTurn(t, adaWs, adaGrant, { at: now - 3000, ms: 3000, outcome: "exhausted" });
    await seedTurn(t, adaWs, adaGrant, { at: now - 4000, ms: 4000 });

    await seedReview(t, now - 1000, 3);
    await seedReview(t, now - 2000, 9, ["cant_first"]);
    await seedReview(t, now - 3000, 9);
    await seedReview(t, now - 4000, 4);
    // A review outside the window is not read.
    await seedReview(t, now - 2 * DAY, 1);

    const page = await asUser(t, staff).query(api.functions.consoleAi.turns, { days: 1 });
    expect(page.hurt.troubledShare).toBe(0.5);
    expect(page.hurt.reviewed).toBe(4);
    expect(page.hurt.handedBackShare).toBe(0.75);
  });

  test("no turns or no reviews give null shares", async () => {
    const t = setupTest();
    const { staff } = await world(t);
    const page = await asUser(t, staff).query(api.functions.consoleAi.turns, { days: 1 });
    expect(page.turns).toBe(0);
    expect(page.hurt).toEqual({ troubledShare: null, p95Ms: 0, handedBackShare: null, reviewed: 0 });
  });

  test("the helpers", () => {
    expect(normalizeConsoleQuery(undefined)).toBe("");
    expect(normalizeConsoleQuery("  @Ada ")).toBe("ada");
    expect(normalizeConsoleQuery("x".repeat(100))).toHaveLength(64);
  });
});

// The window's readers must hold the same bounds the agent report sets.
describe("the console's read bounds", () => {
  test("reads go through the turn log's time index", async () => {
    const t = setupTest();
    const { staff, adaWs, adaGrant } = await world(t);
    await seedTurn(t, adaWs, adaGrant, { at: Date.now() - 1000, ms: 1000 });
    const page = await asUser(t, staff).query(api.functions.consoleAi.turns, { days: 30 });
    expect(page.truncated).toBe(false);
    expect(page.series).toHaveLength(30);
  });
});
