/**
 * THE AI COSTS TAB'S FIGURES: what Jev and the texting assistant cost, by
 * feature, by model, by day and by account, and one account's own breakdown.
 *
 * Asked for by the owner, 2026-10-08 ("Let's do cost first"), drawn from the
 * approved mockup whose shapes are in `aiCostsShape.ts`. Staff only:
 * `functions/admin.ts` calls `requireAdmin` before either handler runs.
 *
 * Money is micro-dollars in the tables and US dollars here, at list price
 * (`lib/jev/meter.ts`). Figures are read from `jevUsage` (cost per day, feature
 * and workspace) and split by model from `aiModelUsage`; a feature's cost before
 * the model table began is in `unrecordedModelUsd`, never guessed at.
 *
 * An account pays for the workspaces it OWNS (`aiCostsRead.ts`). A workspace
 * with two owners is shown under both, so per-account figures are never a
 * total to add up.
 *
 * Nothing here can return text a person wrote: the tables hold counts and
 * costs. A workspace is named by its slug, an account by its email, which the
 * console already shows staff.
 *
 * Reads are bounded by one budget per answer; `truncated` says when it ran out,
 * and every total is then a floor.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { strongestPlan } from "../census";
import { JEV_FEATURES, type JevFeatureName } from "../jev/features";
import { MODEL_USD_PER_MTOK } from "../jev/meter";
import { PREMIUM_PRICE_CENTS, planIsPaying, type PlanStatus } from "../premium";
import {
  AI_COSTS_READ_BUDGET,
  AI_COSTS_TOP_ACCOUNTS,
  modelLabel,
  type AiCostsAccount,
  type AiCostsReport,
} from "./aiCostsShape";
import {
  clampAiCostsDays,
  dayWindow,
  featureLabel,
  modelUsageBetween,
  newBudget,
  ownedWorkspaces,
  ownersOf,
  planWording,
  statusOfWorkspace,
  takeRows,
  usageBetween,
  usd,
  workspaceModelUsage,
  workspaceUsage,
  type ReadBudget,
} from "./aiCostsRead";

const FEATURE_NAMES = Object.keys(JEV_FEATURES) as JevFeatureName[];

/** Only the assistant is counted in questions; every other feature in requests. */
function unitFor(feature: string): string {
  return feature === "assistant" ? "questions" : "requests";
}

function bump(counts: Map<string, number>, key: string, amount: number): void {
  counts.set(key, (counts.get(key) ?? 0) + amount);
}

/** The keys of a count, largest first; ties by name, so the order is stable. */
function byCostDesc(counts: Map<string, number> | undefined): string[] {
  return [...(counts ?? new Map<string, number>()).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
}

function priceOf(model: string): AiCostsReport["models"][number]["price"] {
  const price = MODEL_USD_PER_MTOK.get(model);
  return price ? { ...price } : null;
}

interface WorkspaceSpend {
  id: Id<"workspaces">;
  micro: number;
  byFeature: Map<string, number>;
  /** Assistant calls and failures today: this workspace's use of its cap. */
  askedToday: number;
}

interface AccountSpend {
  id: Id<"users">;
  micro: number;
  byFeature: Map<string, number>;
}

type AccountCard = AiCostsReport["accounts"][number];

async function accountCard(
  ctx: QueryCtx,
  account: AccountSpend,
  workspaces: ReadonlyMap<string, WorkspaceSpend>,
  budget: ReadBudget,
): Promise<AccountCard> {
  const user = await ctx.db.get(account.id);
  const owned = await ownedWorkspaces(ctx, account.id, budget);
  const statuses: PlanStatus[] = [];
  let askedToday = 0;
  for (const workspaceId of owned) {
    statuses.push(await statusOfWorkspace(ctx, workspaceId));
    askedToday += workspaces.get(String(workspaceId))?.askedToday ?? 0;
  }
  return {
    userId: String(account.id),
    email: user?.email ?? null,
    plan: planWording(strongestPlan(statuses)),
    workspaces: owned.length,
    costUsd: usd(account.micro),
    byFeature: [...account.byFeature.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([feature, micro]) => ({ feature, costUsd: usd(micro) })),
    questionsToday: askedToday,
    questionsCap: JEV_FEATURES.assistant.dailyCallsPerWorkspace,
  };
}

/**
 * The report behind the AI costs tab: one window against the window before it,
 * the features, the models, the days, and the accounts that spent most.
 *
 * `now` and `budget` are parameters so a test can name the day and make the
 * read budget small enough to exceed; the admin query passes neither.
 */
export async function aiCostsReportHandler(
  ctx: QueryCtx,
  args: { days?: number },
  now: number = Date.now(),
  budgetRows: number = AI_COSTS_READ_BUDGET,
): Promise<AiCostsReport> {
  const win = dayWindow(clampAiCostsDays(args.days), now);
  const budget = newBudget(budgetRows);
  const usage = await usageBetween(ctx, win.prior[0] ?? win.since, win.today, budget);
  const modelRows = await modelUsageBetween(ctx, win.since, win.today, budget);

  // -- what was spent: the window, the window before it, by feature and day --
  let totalMicro = 0;
  let priorMicro = 0;
  const featureMicro = new Map<string, number>();
  const featureCalls = new Map<string, number>();
  const dailyMicro = new Map<string, Map<string, number>>();
  const workspaces = new Map<string, WorkspaceSpend>();
  for (const row of usage) {
    if (row.day < win.since) {
      priorMicro += row.costMicroUsd;
      continue;
    }
    totalMicro += row.costMicroUsd;
    bump(featureMicro, row.feature, row.costMicroUsd);
    bump(featureCalls, row.feature, row.calls);
    const day = dailyMicro.get(row.day) ?? new Map<string, number>();
    bump(day, row.feature, row.costMicroUsd);
    dailyMicro.set(row.day, day);
    const key = String(row.workspaceId);
    const workspace = workspaces.get(key) ?? { id: row.workspaceId, micro: 0, byFeature: new Map(), askedToday: 0 };
    workspace.micro += row.costMicroUsd;
    bump(workspace.byFeature, row.feature, row.costMicroUsd);
    if (row.feature === "assistant" && row.day === win.today) workspace.askedToday += row.calls + row.failed;
    workspaces.set(key, workspace);
  }

  // -- which model answered: priced at list, and summed per feature --------
  let modelMicro = 0;
  const modelTotals = new Map<string, { inputTokens: number; outputTokens: number; micro: number }>();
  const featureModels = new Map<string, Map<string, number>>();
  for (const row of modelRows) {
    modelMicro += row.costMicroUsd;
    const total = modelTotals.get(row.model) ?? { inputTokens: 0, outputTokens: 0, micro: 0 };
    total.inputTokens += row.inputTokens;
    total.outputTokens += row.outputTokens;
    total.micro += row.costMicroUsd;
    modelTotals.set(row.model, total);
    const byModel = featureModels.get(row.feature) ?? new Map<string, number>();
    bump(byModel, row.model, row.costMicroUsd);
    featureModels.set(row.feature, byModel);
  }

  const features = FEATURE_NAMES.map((feature) => {
    const micro = featureMicro.get(feature) ?? 0;
    const uses = featureCalls.get(feature) ?? 0;
    return {
      feature,
      label: JEV_FEATURES[feature].label,
      models: byCostDesc(featureModels.get(feature)),
      uses,
      unit: unitFor(feature),
      eachUsd: uses > 0 ? usd(micro) / uses : null,
      costUsd: usd(micro),
    };
  }).sort((a, b) => b.costUsd - a.costUsd);

  const models = [...modelTotals.entries()]
    .map(([model, total]) => ({
      model,
      label: modelLabel(model),
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
      price: priceOf(model),
      costUsd: usd(total.micro),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model));

  const assistantCalls = featureCalls.get("assistant") ?? 0;
  const assistantMicro = featureMicro.get("assistant") ?? 0;

  const daily = win.window.map((day) => ({
    day,
    byFeature: FEATURE_NAMES.map((feature) => ({
      feature,
      costUsd: usd(dailyMicro.get(day)?.get(feature) ?? 0),
    })),
  }));

  // -- who pays: owners of paying workspaces, and owners of spending ones ---
  const plans = await takeRows(ctx.db.query("workspacePlans"), budget);
  const payingAccounts = new Set<string>();
  for (const plan of plans) {
    if (!planIsPaying(plan.status)) continue;
    for (const owner of await ownersOf(ctx, plan.workspaceId, budget)) payingAccounts.add(String(owner));
  }

  const ownersByWorkspace = new Map<string, Id<"users">[]>();
  for (const [key, workspace] of workspaces) {
    ownersByWorkspace.set(key, await ownersOf(ctx, workspace.id, budget));
  }

  const accounts = new Map<string, AccountSpend>();
  let payingMicro = 0;
  for (const [key, workspace] of workspaces) {
    const owners = ownersByWorkspace.get(key) ?? [];
    // Counted once, however many of its owners are paying.
    if (owners.some((owner) => payingAccounts.has(String(owner)))) payingMicro += workspace.micro;
    for (const owner of owners) {
      const account = accounts.get(String(owner)) ?? { id: owner, micro: 0, byFeature: new Map<string, number>() };
      account.micro += workspace.micro;
      for (const [feature, micro] of workspace.byFeature) bump(account.byFeature, feature, micro);
      accounts.set(String(owner), account);
    }
  }
  const ranked = [...accounts.values()]
    .filter((account) => account.micro > 0)
    .sort((a, b) => b.micro - a.micro || String(a.id).localeCompare(String(b.id)));
  const top = ranked.slice(0, AI_COSTS_TOP_ACCOUNTS);
  const topCards: AccountCard[] = [];
  for (const account of top) topCards.push(await accountCard(ctx, account, workspaces, budget));

  return {
    days: win.days,
    since: win.since,
    totalUsd: usd(totalMicro),
    priorUsd: usd(priorMicro),
    payingAccounts: payingAccounts.size,
    perPayingAccountUsd: payingAccounts.size > 0 ? usd(payingMicro) / payingAccounts.size : null,
    textedQuestions: assistantCalls,
    perQuestionUsd: assistantCalls > 0 ? usd(assistantMicro) / assistantCalls : null,
    features,
    models,
    unrecordedModelUsd: usd(Math.max(0, totalMicro - modelMicro)),
    daily,
    accounts: topCards,
    moreAccounts: Math.max(0, ranked.length - top.length),
    truncated: budget.truncated,
  };
}

/**
 * One account's breakdown, for the drawer that opens from a row of the report.
 * `null` for a user id that is malformed, names another table, or no longer
 * exists: the drawer then shows nothing rather than an error.
 */
export async function aiCostsAccountHandler(
  ctx: QueryCtx,
  args: { userId: string; days?: number },
  now: number = Date.now(),
  budgetRows: number = AI_COSTS_READ_BUDGET,
): Promise<AiCostsAccount> {
  const userId = ctx.db.normalizeId("users", args.userId);
  if (userId === null) return null;
  const user = await ctx.db.get(userId);
  if (user === null) return null;

  const win = dayWindow(clampAiCostsDays(args.days), now);
  const budget = newBudget(budgetRows);
  const owned = await ownedWorkspaces(ctx, userId, budget);
  const statuses: PlanStatus[] = [];
  const slugs = new Map<string, string>();
  const usage: Doc<"jevUsage">[] = [];
  const modelRows: Doc<"aiModelUsage">[] = [];
  for (const workspaceId of owned) {
    const workspace = await ctx.db.get(workspaceId);
    slugs.set(String(workspaceId), workspace?.slug ?? String(workspaceId));
    statuses.push(await statusOfWorkspace(ctx, workspaceId));
    usage.push(...(await workspaceUsage(ctx, workspaceId, win.since, budget)));
    modelRows.push(...(await workspaceModelUsage(ctx, workspaceId, win.since, budget)));
  }

  let totalMicro = 0;
  let questions = 0;
  let questionMicro = 0;
  const dailyMicro = new Map<string, number>();
  const askedToday = new Map<string, number>();
  const cells = new Map<string, { workspace: string; feature: string; micro: number }>();
  for (const row of usage) {
    totalMicro += row.costMicroUsd;
    bump(dailyMicro, row.day, row.costMicroUsd);
    if (row.feature === "assistant") {
      questions += row.calls;
      questionMicro += row.costMicroUsd;
    }
    if (row.day === win.today) bump(askedToday, row.feature, row.calls + row.failed);
    const key = `${row.workspaceId}\u0000${row.feature}`;
    const cell = cells.get(key) ?? {
      workspace: slugs.get(String(row.workspaceId)) ?? String(row.workspaceId),
      feature: row.feature,
      micro: 0,
    };
    cell.micro += row.costMicroUsd;
    cells.set(key, cell);
  }

  const cellModels = new Map<string, Map<string, number>>();
  for (const row of modelRows) {
    const key = `${row.workspaceId}\u0000${row.feature}`;
    const byModel = cellModels.get(key) ?? new Map<string, number>();
    bump(byModel, row.model, row.costMicroUsd);
    cellModels.set(key, byModel);
  }

  const rows = [...cells.entries()]
    .map(([key, cell]) => ({
      workspace: cell.workspace,
      feature: cell.feature,
      label: featureLabel(cell.feature),
      models: byCostDesc(cellModels.get(key)),
      costUsd: usd(cell.micro),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || a.workspace.localeCompare(b.workspace) || a.feature.localeCompare(b.feature));

  let busiest: { day: string; costUsd: number } | null = null;
  let busiestMicro = 0;
  for (const day of win.window) {
    const micro = dailyMicro.get(day) ?? 0;
    if (micro > busiestMicro) {
      busiestMicro = micro;
      busiest = { day, costUsd: usd(micro) };
    }
  }

  // Every capped feature used today, and the assistant always; the cap is per
  // workspace, so it is summed over the workspaces this account owns.
  const today = FEATURE_NAMES.map((feature) => ({
    feature,
    label: JEV_FEATURES[feature].label,
    used: askedToday.get(feature) ?? 0,
    cap: JEV_FEATURES[feature].dailyCallsPerWorkspace * owned.length,
  }))
    .filter((entry) => entry.used > 0 || entry.feature === "assistant")
    .sort((a, b) => b.used - a.used);

  return {
    userId: String(userId),
    email: user.email ?? null,
    plan: planWording(strongestPlan(statuses)),
    days: win.days,
    totalUsd: usd(totalMicro),
    planUsd: statuses.some(planIsPaying) ? PREMIUM_PRICE_CENTS / 100 : null,
    questionsTexted: questions,
    perQuestionUsd: questions > 0 ? usd(questionMicro) / questions : null,
    busiestDay: busiest,
    today,
    rows,
  };
}
