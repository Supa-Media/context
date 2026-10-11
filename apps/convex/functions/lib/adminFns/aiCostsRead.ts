/**
 * How the AI costs tab reads its figures: the row budget that every read in one
 * answer shares, the day window, who owns a workspace, and what its plan says.
 *
 * `aiCostsReport.ts` says what the figures mean; this file says how they are
 * read, so the bounds are in one place. Nothing here returns anything a person
 * wrote: counts, days, ids, slugs and plan words.
 *
 * ## Attribution: an account pays for the workspaces it owns
 *
 * The same rule as `lib/jev/spend.ts` and the census roster: `workspaceMembers`
 * with role `owner`. A workspace somebody only belongs to is never charged to
 * them. A workspace with two owners counts for both, so the per-account
 * figures are never a total to add up.
 *
 * ## Budget
 *
 * A query may read at most `AI_COSTS_READ_BUDGET` rows in total across all its
 * reads. `takeRows` asks for one row more than is left, so it can tell "exactly
 * enough" from "more than there was room for", and says so rather than dropping
 * rows silently. A budget that ran out makes every total a floor.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { planFor, statusOf } from "../billing/plan";
import { priorWindow } from "../census";
import { type PlanStatus } from "../premium";
import { isJevFeature, JEV_FEATURES } from "../jev/features";
import { dayKey, dayRange } from "../usage";
import { AI_COSTS_READ_BUDGET, AI_COSTS_WINDOWS } from "./aiCostsShape";

/** The console's default window when the request names none. */
const DEFAULT_DAYS = 30;

/** Micro-dollars in a US dollar: the meter's unit and the console's. */
const MICRO_PER_USD = 1_000_000;

export function usd(micro: number): number {
  return micro / MICRO_PER_USD;
}

/** The nearest of the picker's windows; a missing or non-numeric value is the default. */
export function clampAiCostsDays(days: unknown): number {
  if (typeof days !== "number" || !Number.isFinite(days)) return DEFAULT_DAYS;
  return AI_COSTS_WINDOWS.reduce((best, w) => (Math.abs(w - days) < Math.abs(best - days) ? w : best), DEFAULT_DAYS);
}

export interface DayWindow {
  days: number;
  /** The last `days` UTC days, today included, oldest first. */
  window: string[];
  /** The `days` just before `window`, oldest first. */
  prior: string[];
  since: string;
  today: string;
}

export function dayWindow(days: number, now: number): DayWindow {
  const today = dayKey(now);
  const window = dayRange(today, days);
  return { days, window, prior: priorWindow(window), since: window[0] ?? today, today };
}

export interface ReadBudget {
  left: number;
  /** A read had more rows than the budget left room for. */
  truncated: boolean;
}

export function newBudget(total: number = AI_COSTS_READ_BUDGET): ReadBudget {
  return { left: total, truncated: false };
}

/** The next rows of a query, within what the budget has left. Sets `truncated` when rows were left behind. */
export async function takeRows<T>(query: { take(n: number): Promise<T[]> }, budget: ReadBudget): Promise<T[]> {
  const rows = await query.take(budget.left + 1);
  if (rows.length > budget.left) {
    budget.truncated = true;
    rows.length = budget.left;
  }
  budget.left -= rows.length;
  return rows;
}

// -- the usage tables, newest first -------------------------------------

/** `jevUsage` for every workspace and feature from `from` to `to`, inclusive. */
export function usageBetween(ctx: QueryCtx, from: string, to: string, budget: ReadBudget) {
  return takeRows(
    ctx.db
      .query("jevUsage")
      .withIndex("by_day_feature_workspace", (q) => q.gte("day", from).lte("day", to))
      .order("desc"),
    budget,
  );
}

/** `aiModelUsage` for every workspace and feature from `from` to `to`, inclusive. */
export function modelUsageBetween(ctx: QueryCtx, from: string, to: string, budget: ReadBudget) {
  return takeRows(
    ctx.db
      .query("aiModelUsage")
      .withIndex("by_day", (q) => q.gte("day", from).lte("day", to))
      .order("desc"),
    budget,
  );
}

/** One workspace's `jevUsage` from `from` onward. */
export function workspaceUsage(ctx: QueryCtx, workspaceId: Id<"workspaces">, from: string, budget: ReadBudget) {
  return takeRows(
    ctx.db
      .query("jevUsage")
      .withIndex("by_workspace_day", (q) => q.eq("workspaceId", workspaceId).gte("day", from))
      .order("desc"),
    budget,
  );
}

/** One workspace's `aiModelUsage` from `from` onward. */
export function workspaceModelUsage(ctx: QueryCtx, workspaceId: Id<"workspaces">, from: string, budget: ReadBudget) {
  return takeRows(
    ctx.db
      .query("aiModelUsage")
      .withIndex("by_workspace_day", (q) => q.eq("workspaceId", workspaceId).gte("day", from))
      .order("desc"),
    budget,
  );
}

// -- ownership and plans -------------------------------------------------

/** The owners of one workspace. A workspace with none is charged to nobody. */
export async function ownersOf(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  budget: ReadBudget,
): Promise<Id<"users">[]> {
  const members = await takeRows(
    ctx.db.query("workspaceMembers").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)),
    budget,
  );
  return members.filter((member) => member.role === "owner").map((member) => member.userId);
}

/** The workspaces an account owns. Membership alone is not ownership. */
export async function ownedWorkspaces(
  ctx: QueryCtx,
  userId: Id<"users">,
  budget: ReadBudget,
): Promise<Id<"workspaces">[]> {
  const members = await takeRows(
    ctx.db.query("workspaceMembers").withIndex("by_user", (q) => q.eq("userId", userId)),
    budget,
  );
  return members.filter((member) => member.role === "owner").map((member) => member.workspaceId);
}

export async function statusOfWorkspace(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<PlanStatus> {
  return statusOf(await planFor(ctx, workspaceId));
}

/**
 * The roster's words for a plan status, as the console's admin report shows
 * them (`apps/mobile/features/admin/report.ts`, `PLAN_LABELS`). The client
 * cannot be imported from the Convex side, so the table is repeated here: keep
 * the two in step.
 */
const PLAN_WORDS: Record<PlanStatus, string> = {
  active: "Paying",
  past_due: "Past due",
  canceled: "Cancelled",
  unknown: "Unrecognised",
  none: "Free",
};

export function planWording(status: PlanStatus): string {
  return PLAN_WORDS[status];
}

// -- labels --------------------------------------------------------------

/** A feature's label, or its name when it is no longer registered. */
export function featureLabel(feature: string): string {
  return isJevFeature(feature) ? JEV_FEATURES[feature].label : feature;
}
