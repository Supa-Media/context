import { afterEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import {
  AI_COSTS_TOP_ACCOUNTS,
  CLEF_MODEL,
  GLM_MODEL,
  modelLabel,
} from "../functions/lib/adminFns/aiCostsShape";
import { clampAiCostsDays } from "../functions/lib/adminFns/aiCostsRead";
import { aiCostsReportHandler } from "../functions/lib/adminFns/aiCostsReport";
import { JEV_FEATURES } from "../functions/lib/jev/features";
import { MODEL_USD_PER_MTOK, utcDay } from "../functions/lib/jev/meter";
import { PREMIUM_PRICE_CENTS } from "../functions/lib/premium";
import { addMember, asUser, createUser, createWorkspace, setupTest } from "./fixtures.helpers";

/**
 * THE AI COSTS TAB'S QUERIES (`functions/lib/adminFns/aiCostsReport.ts`).
 *
 * Staff only. Rows are inserted straight into `jevUsage` and `aiModelUsage`;
 * how the meter writes them is the meter's own test's job. An account pays for
 * the workspaces it OWNS, so the figures are pinned with a member-only
 * workspace beside an owned one and a workspace with two owners.
 *
 * ## Sabotage record (run as local edits, reverted)
 *
 *   charging a workspace to its members      "an account pays for the workspaces it owns"
 *   questionsToday counting yesterday        "questions today count calls and failures"
 */

const ADMIN = "staff@example.invalid";
const ADA = "ada@example.invalid";
const BO = "bo@example.invalid";
const DAY = 86_400_000;
const USD = 1_000_000;

type T = ReturnType<typeof setupTest>;

afterEach(() => {
  delete process.env[ADMIN_EMAILS_ENV_VAR];
});

/** A UTC day key, `daysAgo` before today. */
function day(daysAgo: number): string {
  return utcDay(Date.now() - daysAgo * DAY);
}

async function spend(
  t: T,
  workspaceId: Id<"workspaces">,
  feature: string,
  opts: { costUsd: number; calls?: number; failed?: number; daysAgo?: number },
) {
  await t.run((ctx) =>
    ctx.db.insert("jevUsage", {
      day: day(opts.daysAgo ?? 0),
      feature,
      workspaceId,
      calls: opts.calls ?? 0,
      failed: opts.failed ?? 0,
      refused: 0,
      questions: 0,
      tokens: 0,
      costMicroUsd: Math.round(opts.costUsd * USD),
      ms: 0,
      updatedAt: Date.now(),
    }),
  );
}

async function modelSpend(
  t: T,
  workspaceId: Id<"workspaces">,
  feature: string,
  model: string,
  opts: { costUsd: number; calls?: number; input?: number; output?: number; daysAgo?: number },
) {
  await t.run((ctx) =>
    ctx.db.insert("aiModelUsage", {
      day: day(opts.daysAgo ?? 0),
      feature,
      model,
      workspaceId,
      calls: opts.calls ?? 1,
      inputTokens: opts.input ?? 0,
      outputTokens: opts.output ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: Math.round(opts.costUsd * USD),
      updatedAt: Date.now(),
    }),
  );
}

async function setPlan(t: T, workspaceId: Id<"workspaces">, status: "active" | "past_due") {
  await t.run((ctx) =>
    ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: false,
      fastSearch: true,
      status,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** A workspace with members and no owner: the one shape an owner-less row can take. */
async function memberOnlyWorkspace(t: T, slug: string, members: Id<"users">[]): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      slug,
      displayName: `SECRET ${slug}`,
      createdBy: members[0],
      kind: "shared",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    for (const userId of members) {
      await ctx.db.insert("workspaceMembers", { workspaceId, userId, role: "member", joinedAt: now });
    }
    return workspaceId;
  });
}

async function world(t: T) {
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  const staff = await createUser(t, ADMIN);
  const ada = await createUser(t, ADA);
  const bo = await createUser(t, BO);
  const adaWs = await createWorkspace(t, ada, "ada", { kind: "personal" });
  const boWs = await createWorkspace(t, bo, "bo", { kind: "personal" });
  return { staff, ada, bo, adaWs, boWs };
}

/**
 * Ada owns `ada`, `shared-ada` (Bo is only a member there) and `pair` (Bo owns
 * it too). Bo owns `bo` and `pair`. `orphan` has no owner: Ada is a member.
 */
async function ownershipWorld(t: T) {
  const base = await world(t);
  const shared = await createWorkspace(t, base.ada, "shared-ada", { kind: "shared" });
  await addMember(t, shared, base.bo, "member");
  const pair = await createWorkspace(t, base.ada, "pair", { kind: "shared" });
  await addMember(t, pair, base.bo, "owner");
  const orphan = await memberOnlyWorkspace(t, "orphan", [base.ada]);
  return { ...base, shared, pair, orphan };
}

/** The report, read as staff. */
async function report(t: T, staff: Id<"users">, days: number) {
  return await asUser(t, staff).query(api.functions.admin.aiCostsReport, { days });
}

/** One account's drawer, read as staff. */
async function drawer(t: T, staff: Id<"users">, userId: string, days = 7) {
  return await asUser(t, staff).query(api.functions.admin.aiCostsAccount, { userId, days });
}

describe("the AI costs report", () => {
  test("only staff may read it", async () => {
    const t = setupTest();
    const { ada } = await world(t);
    await expect(asUser(t, ada).query(api.functions.admin.aiCostsReport, {})).rejects.toThrow();
    await expect(t.query(api.functions.admin.aiCostsReport, {})).rejects.toThrow();
    await expect(asUser(t, ada).query(api.functions.admin.aiCostsAccount, { userId: ada, days: 7 })).rejects.toThrow();
    await expect(t.query(api.functions.admin.aiCostsAccount, { userId: ada })).rejects.toThrow();
  });

  test("totals and the window before it", async () => {
    const t = setupTest();
    const { staff, adaWs, boWs } = await world(t);
    await spend(t, adaWs, "assistant", { costUsd: 1, calls: 1 });
    await spend(t, boWs, "organizer", { costUsd: 2, daysAgo: 3 });
    // The prior seven days: seven to thirteen days before today.
    await spend(t, adaWs, "assistant", { costUsd: 4, daysAgo: 10, calls: 1 });
    // Older than both windows: counted in neither.
    await spend(t, adaWs, "whatChanged", { costUsd: 8, daysAgo: 20 });

    const result = await report(t, staff, 7);
    expect(result.days).toBe(7);
    expect(result.since).toBe(day(6));
    expect(result.totalUsd).toBe(3);
    expect(result.priorUsd).toBe(4);
  });

  test("features include every registered feature, even at zero, costliest first", async () => {
    const t = setupTest();
    const { staff, adaWs } = await world(t);
    await spend(t, adaWs, "assistant", { costUsd: 2, calls: 4 });
    await spend(t, adaWs, "organizer", { costUsd: 0.5, calls: 10 });

    const result = await report(t, staff, 7);
    expect(result.features.map((f) => f.feature)).toEqual(["assistant", "organizer", "ownerSuggest", "whatChanged"]);
    expect(new Set(result.features.map((f) => f.feature))).toEqual(new Set(Object.keys(JEV_FEATURES)));

    expect(result.features[0]).toMatchObject({ feature: "assistant", uses: 4, unit: "questions", costUsd: 2 });
    expect(result.features[0].eachUsd).toBeCloseTo(0.5);
    expect(result.features[1]).toMatchObject({ feature: "organizer", uses: 10, unit: "requests", costUsd: 0.5 });
    expect(result.features[1].eachUsd).toBeCloseTo(0.05);
    expect(result.features[2]).toMatchObject({ feature: "ownerSuggest", uses: 0, costUsd: 0, eachUsd: null, models: [] });
    expect(result.features[3]).toMatchObject({ feature: "whatChanged", uses: 0, costUsd: 0, eachUsd: null });
  });

  test("models aggregate across days and carry their list price, or null when unpriced", async () => {
    const t = setupTest();
    const { staff, adaWs } = await world(t);
    await spend(t, adaWs, "assistant", { costUsd: 0.75, calls: 3 });
    await spend(t, adaWs, "whatChanged", { costUsd: 0.1, calls: 1 });
    await modelSpend(t, adaWs, "assistant", GLM_MODEL, { costUsd: 0.5, calls: 2, input: 1_000_000, output: 1000 });
    await modelSpend(t, adaWs, "assistant", GLM_MODEL, { costUsd: 0.25, calls: 1, input: 500, output: 2000, daysAgo: 2 });
    await modelSpend(t, adaWs, "whatChanged", CLEF_MODEL, { costUsd: 0.1, calls: 1 });

    const result = await report(t, staff, 7);
    expect(result.models).toEqual([
      {
        model: GLM_MODEL,
        label: modelLabel(GLM_MODEL),
        inputTokens: 1_000_500,
        outputTokens: 3000,
        price: MODEL_USD_PER_MTOK.get(GLM_MODEL),
        costUsd: 0.75,
      },
      { model: CLEF_MODEL, label: modelLabel(CLEF_MODEL), inputTokens: 0, outputTokens: 0, price: null, costUsd: 0.1 },
    ]);
    expect(result.features.find((f) => f.feature === "assistant")?.models).toEqual([GLM_MODEL]);
    expect(result.features.find((f) => f.feature === "whatChanged")?.models).toEqual([CLEF_MODEL]);
  });

  test("unrecorded model spend is jevUsage beyond the models, and never negative", async () => {
    const t = setupTest();
    const { staff, adaWs } = await world(t);
    // Priced by a model: nothing unrecorded.
    await spend(t, adaWs, "assistant", { costUsd: 1, calls: 1 });
    await modelSpend(t, adaWs, "assistant", GLM_MODEL, { costUsd: 1 });
    // Before models were recorded: three dollars in jevUsage, no model row.
    await spend(t, adaWs, "organizer", { costUsd: 3, calls: 1, daysAgo: 5 });

    const result = await report(t, staff, 7);
    expect(result.totalUsd).toBe(4);
    expect(result.unrecordedModelUsd).toBe(3);
  });

  test("a model row with no matching spend (a stale or partial write) floors unrecorded at zero", async () => {
    const t = setupTest();
    const { staff, adaWs } = await world(t);
    await spend(t, adaWs, "assistant", { costUsd: 1, calls: 1 });
    await modelSpend(t, adaWs, "assistant", GLM_MODEL, { costUsd: 2 });

    const result = await report(t, staff, 7);
    expect(result.totalUsd).toBe(1);
    expect(result.unrecordedModelUsd).toBe(0);
  });

  test("daily is zero-filled, oldest first, with every feature each day", async () => {
    const t = setupTest();
    const { staff, adaWs } = await world(t);
    await spend(t, adaWs, "assistant", { costUsd: 1, calls: 1 });
    await spend(t, adaWs, "organizer", { costUsd: 2, calls: 1, daysAgo: 4 });
    await spend(t, adaWs, "assistant", { costUsd: 0.5, calls: 1, daysAgo: 4 });

    const result = await report(t, staff, 7);
    expect(result.daily.map((d) => d.day)).toEqual([6, 5, 4, 3, 2, 1, 0].map(day));
    for (const entry of result.daily) {
      expect(entry.byFeature.map((f) => f.feature)).toEqual(Object.keys(JEV_FEATURES));
    }
    const fourDaysAgo = result.daily[2];
    expect(fourDaysAgo.byFeature.find((f) => f.feature === "organizer")?.costUsd).toBe(2);
    expect(fourDaysAgo.byFeature.find((f) => f.feature === "assistant")?.costUsd).toBe(0.5);
    expect(result.daily[1].byFeature.every((f) => f.costUsd === 0)).toBe(true);
    expect(result.daily[6].byFeature.find((f) => f.feature === "assistant")?.costUsd).toBe(1);
  });

  test("an account pays for the workspaces it owns, never for one it only belongs to", async () => {
    const t = setupTest();
    const { staff, ada, bo, adaWs, boWs, shared, pair, orphan } = await ownershipWorld(t);
    await spend(t, adaWs, "organizer", { costUsd: 1 });
    await spend(t, boWs, "organizer", { costUsd: 2 });
    await spend(t, shared, "organizer", { costUsd: 4 });
    await spend(t, pair, "organizer", { costUsd: 8 });
    await spend(t, orphan, "organizer", { costUsd: 16 });

    const result = await report(t, staff, 7);
    expect(result.totalUsd).toBe(31);
    // Ada owns ada, shared-ada and pair; Bo owns bo and pair. The orphan is in
    // the total and in no account.
    expect(result.accounts.map((a) => [a.email, a.costUsd, a.workspaces])).toEqual([
      [ADA, 13, 3],
      [BO, 10, 2],
    ]);
    expect(result.accounts.map((a) => a.userId)).toEqual([String(ada), String(bo)]);
  });

  test("paying accounts own a paying workspace, and paying spend is what they own", async () => {
    const t = setupTest();
    const { staff, adaWs, boWs, shared, pair, orphan } = await ownershipWorld(t);
    await spend(t, adaWs, "organizer", { costUsd: 1 });
    await spend(t, boWs, "organizer", { costUsd: 2 });
    await spend(t, shared, "organizer", { costUsd: 4 });
    await spend(t, pair, "organizer", { costUsd: 8 });
    await spend(t, orphan, "organizer", { costUsd: 16 });

    const none = await report(t, staff, 7);
    expect(none.payingAccounts).toBe(0);
    expect(none.perPayingAccountUsd).toBeNull();

    await setPlan(t, adaWs, "active");
    const adaPays = await report(t, staff, 7);
    expect(adaPays.payingAccounts).toBe(1);
    // Ada's workspaces: ada 1, shared-ada 4, pair 8.
    expect(adaPays.perPayingAccountUsd).toBe(13);

    await setPlan(t, boWs, "active");
    // A paying workspace with no owner makes nobody a paying account.
    await setPlan(t, orphan, "active");
    // A past-due plan does not count.
    await setPlan(t, shared, "past_due");
    const bothPay = await report(t, staff, 7);
    expect(bothPay.payingAccounts).toBe(2);
    // Owned by a paying account: ada 1, shared-ada 4, pair 8, bo 2. Not the orphan.
    expect(bothPay.perPayingAccountUsd).toBe(7.5);
  });

  test("questions today count calls and failures across owned workspaces, against the cap", async () => {
    const t = setupTest();
    const { staff, adaWs, boWs, shared } = await ownershipWorld(t);
    await spend(t, adaWs, "assistant", { costUsd: 0.5, calls: 5, failed: 1 });
    await spend(t, shared, "assistant", { costUsd: 0.2, calls: 2 });
    await spend(t, boWs, "assistant", { costUsd: 0.3, calls: 3 });
    // Yesterday is in the window, but not in today's count.
    await spend(t, adaWs, "assistant", { costUsd: 1, calls: 40, daysAgo: 1 });

    const result = await report(t, staff, 7);
    expect(result.textedQuestions).toBe(50);
    expect(result.perQuestionUsd).toBeCloseTo(2 / 50);
    const ada = result.accounts.find((a) => a.email === ADA);
    const bo = result.accounts.find((a) => a.email === BO);
    expect(ada?.questionsToday).toBe(8);
    expect(ada?.questionsCap).toBe(JEV_FEATURES.assistant.dailyCallsPerWorkspace);
    expect(bo?.questionsToday).toBe(3);
  });

  test("the top accounts by cost, and how many others spent", async () => {
    const t = setupTest();
    const { staff } = await world(t);
    for (let i = 0; i < 8; i += 1) {
      const user = await createUser(t, `u${i}@example.invalid`);
      const ws = await createWorkspace(t, user, `u${i}`, { kind: "personal" });
      await spend(t, ws, "organizer", { costUsd: i + 1 });
    }
    expect(AI_COSTS_TOP_ACCOUNTS).toBe(6);

    const result = await report(t, staff, 7);
    expect(result.accounts.map((a) => a.costUsd)).toEqual([8, 7, 6, 5, 4, 3]);
    expect(result.moreAccounts).toBe(2);
    expect(result.truncated).toBe(false);
  });

  test("the account drawer: totals, plan, busiest day, today and rows", async () => {
    const t = setupTest();
    const { staff, ada, bo, adaWs, shared } = await ownershipWorld(t);
    await setPlan(t, adaWs, "active");
    await spend(t, adaWs, "assistant", { costUsd: 0.3, calls: 3 });
    await modelSpend(t, adaWs, "assistant", GLM_MODEL, { costUsd: 0.3, calls: 3 });
    await spend(t, adaWs, "organizer", { costUsd: 1, calls: 1, daysAgo: 2 });
    await spend(t, shared, "assistant", { costUsd: 0.2, calls: 2 });

    const result = await drawer(t, staff, String(ada));
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result).toMatchObject({
      userId: String(ada),
      email: ADA,
      plan: "Paying",
      days: 7,
      planUsd: PREMIUM_PRICE_CENTS / 100,
      questionsTexted: 5,
      busiestDay: { day: day(2), costUsd: 1 },
    });
    expect(result.totalUsd).toBeCloseTo(1.5);
    expect(result.perQuestionUsd).toBeCloseTo(0.5 / 5);
    // Only the assistant (always shown) and features used today. The cap is
    // per workspace, summed over the three workspaces Ada owns.
    expect(result.today).toEqual([
      {
        feature: "assistant",
        label: JEV_FEATURES.assistant.label,
        used: 5,
        cap: JEV_FEATURES.assistant.dailyCallsPerWorkspace * 3,
      },
    ]);
    expect(result.rows.map((r) => [r.workspace, r.feature, r.models])).toEqual([
      ["ada", "organizer", []],
      ["ada", "assistant", [GLM_MODEL]],
      ["shared-ada", "assistant", []],
    ]);
    expect(result.rows.map((r) => r.costUsd)).toEqual([1, 0.3, 0.2]);

    // Bo owns no paying workspace: no plan fee, and nothing spent today.
    const bos = await drawer(t, staff, String(bo));
    expect(bos).toMatchObject({ plan: "Free", planUsd: null, busiestDay: null, questionsTexted: 0 });
    expect(bos?.totalUsd).toBe(0);
    expect(bos?.perQuestionUsd).toBeNull();
    expect(bos?.rows).toEqual([]);
  });

  test("an unknown, garbage, or wrong-table user id returns null rather than throwing", async () => {
    const t = setupTest();
    const { staff, ada, adaWs } = await world(t);
    const gone = await createUser(t, "gone@example.invalid");
    await t.run((ctx) => ctx.db.delete(gone));

    await expect(drawer(t, staff, "not-an-id")).resolves.toBeNull();
    await expect(drawer(t, staff, "")).resolves.toBeNull();
    await expect(drawer(t, staff, String(gone))).resolves.toBeNull();
    // A workspace id is a real id, but not a users id.
    await expect(drawer(t, staff, String(adaWs))).resolves.toBeNull();
    await expect(drawer(t, staff, String(ada))).resolves.not.toBeNull();
  });

  test("a window that runs past the read budget says so, and its totals become a floor", async () => {
    const t = setupTest();
    const { adaWs, boWs, shared } = await ownershipWorld(t);
    await spend(t, adaWs, "organizer", { costUsd: 1 });
    await spend(t, boWs, "organizer", { costUsd: 2 });
    await spend(t, shared, "organizer", { costUsd: 4 });

    const full = await t.run((ctx) => aiCostsReportHandler(ctx, { days: 7 }));
    expect(full.truncated).toBe(false);
    expect(full.totalUsd).toBe(7);

    // Budget of two rows against three: one row is left behind.
    const cut = await t.run((ctx) => aiCostsReportHandler(ctx, { days: 7 }, Date.now(), 2));
    expect(cut.truncated).toBe(true);
    expect(cut.totalUsd).toBeLessThan(7);
  });

  test("the report and drawer return numbers, ids, slugs, emails and labels, and nothing else", async () => {
    const t = setupTest();
    const { staff, ada, bo, adaWs, shared, pair } = await ownershipWorld(t);
    await setPlan(t, adaWs, "active");
    await spend(t, adaWs, "assistant", { costUsd: 0.3, calls: 3, failed: 1 });
    await modelSpend(t, adaWs, "assistant", GLM_MODEL, { costUsd: 0.3, calls: 3, input: 10, output: 10 });
    await spend(t, shared, "organizer", { costUsd: 0.6, calls: 1 });
    await spend(t, pair, "whatChanged", { costUsd: 0.1, calls: 1, daysAgo: 1 });
    await modelSpend(t, pair, "whatChanged", CLEF_MODEL, { costUsd: 0.1, calls: 1, daysAgo: 1 });

    const reportValue = await report(t, staff, 30);
    const drawerValue = await drawer(t, staff, String(ada), 30);
    // Every string the console may show: the people, the workspaces and their
    // slugs, the features and their labels, the models, the plan words, and ids.
    const allowed = new Set<string>([
      ADMIN, ADA, BO, "ada", "bo", "shared-ada", "pair", "orphan", String(ada), String(bo),
      ...Object.keys(JEV_FEATURES), ...Object.values(JEV_FEATURES).map((f) => f.label),
      "questions", "requests", GLM_MODEL, CLEF_MODEL, modelLabel(GLM_MODEL), modelLabel(CLEF_MODEL), "Paying", "Free",
    ]);
    const strings: string[] = [];
    const numbers: number[] = [];
    const walk = (value: unknown) => {
      if (typeof value === "string") strings.push(value);
      else if (typeof value === "number") numbers.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(reportValue);
    walk(drawerValue);

    expect(strings.length).toBeGreaterThan(20);
    for (const text of strings) {
      const isDay = /^\d{4}-\d{2}-\d{2}$/.test(text);
      expect(isDay || allowed.has(text), `unexpected string field: ${text}`).toBe(true);
    }
    expect(numbers.every((n) => Number.isFinite(n))).toBe(true);
    // A workspace's display name is never part of the figures.
    expect(JSON.stringify([reportValue, drawerValue])).not.toContain("SECRET");
  });

  test("the helpers", () => {
    expect(clampAiCostsDays(undefined)).toBe(30);
    expect(clampAiCostsDays(Number.NaN)).toBe(30);
    expect(clampAiCostsDays(2)).toBe(7);
    expect(clampAiCostsDays(45)).toBe(30);
    expect(clampAiCostsDays(1000)).toBe(90);
  });
});
