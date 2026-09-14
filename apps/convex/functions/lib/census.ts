/**
 * The census arithmetic: control-plane rows in, dashboard figures out.
 *
 * Pure functions, no database and no network, for the reason `lib/usage.ts`
 * and `lib/premium.ts` are shaped this way — a number on the staff dashboard
 * is read once and quoted for a quarter afterwards, so the arithmetic behind
 * it has to be checkable without standing a deployment up.
 *
 * ## What a census is, and what it is not
 *
 * `usageDaily` counts *events*, and it only counts them from the day somebody
 * added the counter. A census counts *rows that exist now* and buckets them by
 * when they were created, which makes it retroactive and exact: the growth
 * curve for a product that has been running for a year is correct on the day
 * the curve is written. That is the whole reason this module exists beside the
 * usage report rather than inside it.
 *
 * The trade is that counting rows does not scale, and the trade is taken
 * deliberately rather than hidden — see `CENSUS_CEILING`.
 *
 * ## Still metadata only
 *
 * Everything here counts accounts, contexts, bindings, plans and grants. It
 * touches nothing a customer wrote, and `functions/admin.ts` carries the
 * standing rule this module must not be used to break: an admin screen is not
 * a licence to hold a record of what customers wrote or searched for.
 */

import { PREMIUM_PRICE_CENTS, type PlanStatus } from "./premium";
import { dayKey, dayRange } from "./usage";

/**
 * How many rows of one table a census may read before its figures become
 * floors.
 *
 * **Low on purpose, and it is a statement about the technique rather than a
 * tuning knob.** Convex has no count API, so a census is a table scan; a scan
 * is bounded by the per-query document and byte limits, and the tables read
 * together here include the two widest rows in the schema (a storage binding
 * and a Google connection each carry sealed envelopes). Five hundred rows
 * across ten tables sits comfortably inside both limits with room for the rows
 * to grow; ten thousand does not, and the failure mode of guessing wrong is
 * the one screen whose job is to tell you the product is growing, throwing
 * because it did.
 *
 * Past this, every derived figure is reported as a floor and the trend curves
 * are withheld rather than drawn from a partial page — `pageOf` is what
 * carries that fact upwards. The point at which the floors start being
 * unhelpful is the point at which this technique should be replaced by
 * maintained aggregates, which is a decision somebody takes, not a constant
 * somebody raises.
 */
export const CENSUS_CEILING = 500;

/** A number that may be a floor, in the same language `noteCount` uses. */
export interface CountedTotal {
  count: number;
  /** `true` when the ceiling was reached, so `count` is a floor. */
  isFloor: boolean;
}

/** One day's value in a series. */
export interface Point {
  day: string;
  count: number;
}

/** One bounded read, and whether it filled. */
export interface Page<T> {
  rows: T[];
  isFloor: boolean;
}

/**
 * One page of rows, and whether the table had more.
 *
 * Callers take `CENSUS_CEILING + 1` — one more than the ceiling, so "exactly
 * at the ceiling" and "past it" are distinguishable, which is the same reason
 * `countUpTo` in `functions/admin.ts` takes one extra.
 */
export function pageOf<T>(
  taken: readonly T[],
  ceiling: number = CENSUS_CEILING,
): Page<T> {
  return taken.length > ceiling
    ? { rows: taken.slice(0, ceiling), isFloor: true }
    : { rows: [...taken], isFloor: false };
}

/** The total a page describes, as a floor when the page filled. */
export function totalOf<T>(page: Page<T>): CountedTotal {
  return { count: page.rows.length, isFloor: page.isFloor };
}

/**
 * How many of these were created on each day of the window.
 *
 * Bucketed by UTC date, exactly as `usageDaily` is, so a census figure and a
 * counter figure for the same day mean the same day.
 */
export function addedPerDay(
  createdAt: readonly number[],
  window: readonly string[],
): Point[] {
  const counts = new Map<string, number>(window.map((day) => [day, 0]));
  for (const at of createdAt) {
    const day = dayKey(at);
    const current = counts.get(day);
    if (current !== undefined) counts.set(day, current + 1);
  }
  return window.map((day) => ({ day, count: counts.get(day) ?? 0 }));
}

/**
 * The running total at the end of each day in the window.
 *
 * Counts **everything created on or before that day**, not only what landed
 * inside the window — a cumulative curve that restarts at the left edge is a
 * curve that says a year-old product was founded thirty days ago.
 *
 * Day keys are ISO, so a lexical comparison is a chronological one.
 */
export function cumulativePerDay(
  createdAt: readonly number[],
  window: readonly string[],
): Point[] {
  const days = createdAt.map(dayKey).sort();
  let index = 0;
  let running = 0;
  return window.map((day) => {
    while (index < days.length && days[index] <= day) {
      running += 1;
      index += 1;
    }
    return { day, count: running };
  });
}

/** How many of these were created inside the window. */
export function countInWindow(
  createdAt: readonly number[],
  window: readonly string[],
): number {
  if (window.length === 0) return 0;
  const first = window[0];
  const last = window[window.length - 1];
  let total = 0;
  for (const at of createdAt) {
    const day = dayKey(at);
    if (day >= first && day <= last) total += 1;
  }
  return total;
}

/**
 * The window of the same length immediately before this one.
 *
 * What makes "new this month" a number with something to compare against. At
 * two to ten customers a percentage is noise — one signup is `+100%` — so the
 * console prints the two counts and their difference, and this is the half
 * that has to be computed where the days are.
 */
export function priorWindow(window: readonly string[]): string[] {
  if (window.length === 0) return [];
  const first = Date.parse(`${window[0]}T00:00:00.000Z`);
  if (Number.isNaN(first)) return [];
  return dayRange(dayKey(first - 86_400_000), window.length);
}

/**
 * Monthly recurring revenue, in cents.
 *
 * Derived from `PREMIUM_PRICE_CENTS` rather than restating it: one price, one
 * place, and a price change cannot leave the dashboard reporting the old one.
 * Cents, so no float ever holds money.
 *
 * It counts **contexts that are paying right now** — `status: "active"` — and
 * therefore deliberately excludes `past_due`, which is a card that was
 * declined and not revenue.
 */
export function mrrCents(payingContexts: number): number {
  return Math.max(0, Math.trunc(payingContexts)) * PREMIUM_PRICE_CENTS;
}

/**
 * A ratio to one decimal, or `null` where there is nothing to divide by.
 *
 * `null` rather than `0`: "no accounts yet" and "every account has no context"
 * are different facts and the screen renders them differently.
 */
export function perCapita(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10) / 10;
}

/**
 * Counts by key, largest first, ties broken by key.
 *
 * Deterministic order because this feeds a list a person reads twice a week:
 * two providers on the same count must not swap places between loads.
 */
export function tally(values: readonly string[]): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key));
}

/**
 * The thresholds one account can have crossed.
 *
 * **Not a nested funnel, and the difference matters.** Each step is counted
 * independently, so a later step can be *larger* than an earlier one — which
 * is a real and interesting state rather than a bug to normalize away: a
 * person with a client connected to a context whose bucket never verified is
 * exactly the customer to go and talk to, and a funnel that clamped each step
 * to the one above it would hide them.
 */
export const FUNNEL_STEPS = [
  "signed-up",
  "made-a-context",
  "connected-storage",
  "connected-a-client",
  "paying",
] as const;

export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/** What one account has done, as the funnel reads it. */
export interface AccountFacts {
  hasContext: boolean;
  hasConnectedStorage: boolean;
  hasActiveClient: boolean;
  isPaying: boolean;
}

export interface FunnelRow {
  step: FunnelStep;
  count: number;
}

export function funnelOf(accounts: readonly AccountFacts[]): FunnelRow[] {
  return [
    { step: "signed-up", count: accounts.length },
    {
      step: "made-a-context",
      count: accounts.filter((a) => a.hasContext).length,
    },
    {
      step: "connected-storage",
      count: accounts.filter((a) => a.hasConnectedStorage).length,
    },
    {
      step: "connected-a-client",
      count: accounts.filter((a) => a.hasActiveClient).length,
    },
    { step: "paying", count: accounts.filter((a) => a.isPaying).length },
  ];
}

/**
 * The strongest plan status across the contexts one account owns.
 *
 * An account owning a paying context and three free ones is a paying customer;
 * reporting it as `none` because that was the last row read would be a
 * customer the dashboard loses. `none` is the floor, and is what an account
 * owning nothing gets.
 */
const PLAN_RANK: Record<PlanStatus, number> = {
  none: 0,
  unknown: 1,
  canceled: 2,
  past_due: 3,
  active: 4,
};

export function strongestPlan(statuses: readonly PlanStatus[]): PlanStatus {
  let best: PlanStatus = "none";
  for (const status of statuses) {
    if (PLAN_RANK[status] > PLAN_RANK[best]) best = status;
  }
  return best;
}
