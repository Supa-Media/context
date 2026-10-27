import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { clampTexDays } from "../functions/lib/adminFns/texReport";
import { asUser, createUser, createWorkspace, seedGrant, setupTest } from "./fixtures.helpers";

/**
 * THE TEX TAB'S REPORT (`functions/lib/adminFns/texReport.ts`).
 *
 * Staff only; texts handled by where they came from, spend by model and day,
 * and the window's scored conversations as rows the tab slices. Rows are
 * seeded straight into the tables: how they get there is `agentTurns.test.ts`
 * and `controlPlane/texReviews.test.ts`.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-24).
 *
 *  1. `texReport` without `requireAdmin`. → "only staff may read it" fails.
 *  2. Older turns counted under `app` instead of `older`. → "texts by where
 *     they came from…" fails.
 */

const ADMIN = "staff@example.invalid";
const DAY = 86_400_000;
const THINK = "fake-provider/think-model";
const MAIN = "fake-provider/main-model";

type T = ReturnType<typeof setupTest>;

async function world(t: T) {
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  const staff = await createUser(t, ADMIN);
  const ada = await createUser(t, "ada@example.invalid");
  const adaWs = await createWorkspace(t, ada, "ada", { kind: "personal" });
  const grant = await seedGrant(t, adaWs, ada, "context_texts", "hash-ada");
  return { staff, ada, adaWs, grant };
}

describe("the tex report", () => {
  test("only staff may read it", async () => {
    const t = setupTest();
    const { ada } = await world(t);
    await expect(asUser(t, ada).query(api.functions.admin.texReport, {})).rejects.toThrow();
    await expect(t.query(api.functions.admin.texReport, {})).rejects.toThrow();
  });

  test("texts by where they came from, spend by model and day, tools, and the scored conversations", async () => {
    const t = setupTest();
    const { staff, adaWs, grant } = await world(t);
    const now = Date.now();
    const base = {
      workspaceId: adaWs,
      grantId: grant,
      client: "texts" as const,
      provider: "builtin",
      outcome: "answered" as const,
      ms: 1_000,
      modelMs: 800,
      toolMs: 200,
      rounds: 2,
      inputTokens: 100,
      outputTokens: 10,
    };
    await t.run(async (ctx) => {
      await ctx.db.insert("agentTurns", {
        ...base,
        model: MAIN,
        at: now - 60_000,
        kind: "one",
        costMicroUsd: 15_450,
        models: [
          { model: THINK, inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costMicroUsd: 15_000 },
          { model: MAIN, inputTokens: 2_000, outputTokens: 500, cacheReadTokens: 400, cacheWriteTokens: 0, costMicroUsd: 450 },
        ],
        trace: [{ kind: "tool", tool: "browse", ok: false, ms: 200 }, { kind: "model", ok: true, ms: 800 }],
      });
      await ctx.db.insert("agentTurns", { ...base, model: MAIN, at: now - 2 * DAY, kind: "group", costMicroUsd: 300, outcome: "failed", trace: [] });
      // Logged before kinds and costs were kept.
      await ctx.db.insert("agentTurns", { ...base, model: MAIN, at: now - 3 * DAY, trace: [{ kind: "tool", tool: "browse", ok: true, ms: 10 }] });
      // Outside a week.
      await ctx.db.insert("agentTurns", { ...base, model: MAIN, at: now - 9 * DAY, kind: "job", trace: [] });
      await ctx.db.insert("texReviewScores", {
        day: "2026-10-24",
        at: now - 30_000,
        kind: "one",
        reason: "frustrated",
        goal: 4,
        independence: 3,
        turns: 5,
        friendly: 6,
        calm: 2,
        task: "web_errand",
        signals: ["try_again"],
        texts: 2,
        who: "new",
        costMicroUsd: 15_450,
        thought: true,
      });
      // A row from before codes were kept.
      await ctx.db.insert("texReviewScores", { day: "2026-10-20", at: now - 4 * DAY, kind: "group", reason: "ended", goal: 9, independence: 9, turns: 9, friendly: 9, calm: 10 });
    });

    const report = await asUser(t, staff).query(api.functions.admin.texReport, { days: 7 });
    expect(report.days).toBe(7);
    expect(report.turns.total).toBe(3);
    expect(report.turns.byKind).toEqual({ one: 1, group: 1, job: 0, routine: 0, app: 0, older: 1 });
    expect(report.turns).toMatchObject({ answered: 2, failed: 1, costMicroUsd: 15_750, priced: 2 });
    expect(report.turns.byDay).toHaveLength(7);
    // Today's one turn answered a person, and its browse failed: a troubled text.
    expect(report.turns.byDay.at(-1)).toMatchObject({ turns: 1, texts: 1, troubled: 1, costMicroUsd: 15_450 });
    // The failed group turn two days ago; the older turn answered with its tool fine.
    expect(report.turns.byDay.at(-3)).toMatchObject({ turns: 1, texts: 1, troubled: 1 });
    expect(report.turns.byDay.at(-4)).toMatchObject({ turns: 1, texts: 0, troubled: 0 });
    expect(report.turns.models[0]).toMatchObject({ model: THINK, turns: 1, costMicroUsd: 15_000 });
    expect(report.turns.models.find((row) => row.model === MAIN)).toMatchObject({ turns: 3, cacheReadTokens: 400, costMicroUsd: 750 });
    expect(report.turns.tools).toEqual([{ tool: "browse", calls: 2, failed: 1 }]);
    expect(report.reviews).toEqual([
      expect.objectContaining({ task: "web_errand", signals: ["try_again"], texts: 2, who: "new", costMicroUsd: 15_450, thought: true, calm: 2 }),
      expect.objectContaining({ task: null, signals: [], texts: null, who: null, costMicroUsd: null, thought: null, calm: 10 }),
    ]);
  });

  test("windows snap to a week, a month or ninety days; turn figures stop at thirty", async () => {
    expect(clampTexDays(undefined)).toBe(30);
    expect(clampTexDays(1)).toBe(7);
    expect(clampTexDays(80)).toBe(90);
    const t = setupTest();
    const { staff } = await world(t);
    const report = await asUser(t, staff).query(api.functions.admin.texReport, { days: 90 });
    expect(report.turnDays).toBe(30);
    expect(report.turns.byDay).toHaveLength(30);
  });
});

describe("model performance", () => {
  test("rounds, failures, retries, cuts and fallbacks per model; the router's picks; where the time goes", async () => {
    const t = setupTest();
    const { staff, adaWs, grant } = await world(t);
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("agentTurns", {
        workspaceId: adaWs,
        grantId: grant,
        client: "texts",
        kind: "one",
        provider: "builtin",
        model: MAIN,
        outcome: "answered",
        at: now - 60_000,
        ms: 9_000,
        modelMs: 6_000,
        toolMs: 3_000,
        rounds: 3,
        inputTokens: 10,
        outputTokens: 10,
        trace: [
          { kind: "router", tier: "think", confidence: 0.8, model: THINK, ok: true, ms: 50 },
          { kind: "model", model: THINK, ok: false, status: 529, retried: true, ms: 1_000 },
          { kind: "fallback", model: MAIN, status: 529, ok: true, ms: 0 },
          { kind: "model", model: MAIN, ok: true, cut: true, ms: 5_000 },
          { kind: "tool", tool: "browse", ok: true, ms: 3_000 },
        ],
      }),
    );
    const { performance } = await asUser(t, staff).query(api.functions.admin.texReport, { days: 7 });
    expect(performance.time).toMatchObject({ totalMs: 9_000, modelMs: 6_000, toolMs: 3_000, p50: 9_000 });
    expect(performance.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: THINK, rounds: 1, failed: 1, retried: 1, cut: 0, fallbacks: 0 }),
        expect.objectContaining({ model: MAIN, rounds: 1, failed: 0, cut: 1, fallbacks: 1, p50: 5_000 }),
      ]),
    );
    expect(performance.router).toEqual({ picks: 1, think: 1, confidence: 0.8 });
    expect(performance.daily.at(-1)).toEqual({ p50: 9_000, p95: 9_000 });
    expect(performance.tools).toEqual([{ tool: "browse", p50: 3_000 }]);
  });
});
