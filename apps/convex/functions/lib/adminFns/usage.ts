/**
 * The handler for `admin.usageReport`, and the validators and helpers it
 * shares with `census.ts`.
 *
 * Split out of `functions/admin.ts` — see that file's header for the
 * credential-boundary rule this whole module exists under, and see
 * `usageReport`'s own doc comment there for why the totals are floors.
 */

import { v } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
import { clampReportDays, dayKey, dayRange, USAGE_METRICS } from "../usage";

/**
 * How many rows a total may read before it becomes a floor.
 *
 * One page, sized so the common case is an exact number and the uncommon one
 * is a legible "10,000+" rather than a failed query.
 */
export const COUNT_CEILING = 10_000;

/**
 * The wire form of `CountedTotal`. See `structure.test.ts`: a public function
 * with no `returns:` hands the credential guard a schema of `"null"`, which it
 * reads and passes whatever the function actually returns.
 */
export const countedTotalValidator = v.object({
  count: v.number(),
  isFloor: v.boolean(),
});

export interface CountedTotal {
  count: number;
  /** `true` when the ceiling was reached, so `count` is a floor. */
  isFloor: boolean;
}

export async function countUpTo(
  ctx: { db: { query: (table: "workspaces" | "users") => { take: (n: number) => Promise<unknown[]> } } },
  table: "workspaces" | "users",
): Promise<CountedTotal> {
  // One more than the ceiling, so "exactly at the ceiling" and "more than the
  // ceiling" are distinguishable — reading exactly `COUNT_CEILING` rows and
  // reporting a floor would understate a number that happened to be exact.
  const rows = await ctx.db.query(table).take(COUNT_CEILING + 1);
  return rows.length > COUNT_CEILING
    ? { count: COUNT_CEILING, isFloor: true }
    : { count: rows.length, isFloor: false };
}

export interface MetricSeries {
  metric: string;
  /** One entry per day in the requested window, oldest first, zeroes included. */
  points: { day: string; count: number }[];
  total: number;
}

/**
 * Daily counters across the requested window.
 *
 * Zero-filled: a day with no rows reads `0` rather than being absent, because
 * a trend line with holes in it is read as missing data and a zero is a fact.
 *
 * The window is clamped (`clampReportDays`) so an argument cannot ask for a
 * full-table scan.
 */
export async function usageReportHandler(
  ctx: QueryCtx,
  args: { days?: number },
): Promise<{
  days: number;
  window: string[];
  series: MetricSeries[];
  activeContexts: { points: { day: string; count: number }[]; distinctInWindow: number };
  totals: { workspaces: CountedTotal; users: CountedTotal };
}> {
  const days = clampReportDays(args.days);
  const window = dayRange(dayKey(Date.now()), days);
  const inWindow = new Set(window);

  const series: MetricSeries[] = [];
  for (const metric of USAGE_METRICS) {
    const counts = new Map<string, number>(window.map((day) => [day, 0]));
    // Ranged on `by_metric_day` so the read is bounded by the window rather
    // than by how long the platform has been running.
    const rows = await ctx.db
      .query("usageDaily")
      .withIndex("by_metric_day", (q) =>
        q.eq("metric", metric).gte("day", window[0]).lte("day", window[window.length - 1]),
      )
      .collect();
    for (const row of rows) {
      if (!inWindow.has(row.day)) continue;
      counts.set(row.day, (counts.get(row.day) ?? 0) + row.count);
    }
    const points = window.map((day) => ({ day, count: counts.get(day) ?? 0 }));
    series.push({
      metric,
      points,
      total: points.reduce((sum, point) => sum + point.count, 0),
    });
  }

  // Active contexts are a cardinality, not a sum — see the schema comment on
  // `usageActiveDaily`. Counted per day over distinct workspaces, and again
  // over the whole window, because "active today" and "active this month"
  // are different questions and neither is derivable from the other.
  const activeByDay = new Map<string, Set<string>>(
    window.map((day) => [day, new Set<string>()]),
  );
  const activeInWindow = new Set<string>();
  for (const day of window) {
    const rows = await ctx.db
      .query("usageActiveDaily")
      .withIndex("by_day", (q) => q.eq("day", day))
      .collect();
    for (const row of rows) {
      activeByDay.get(day)?.add(row.workspaceId);
      activeInWindow.add(row.workspaceId);
    }
  }

  return {
    days,
    window,
    series,
    activeContexts: {
      points: window.map((day) => ({
        day,
        count: activeByDay.get(day)?.size ?? 0,
      })),
      distinctInWindow: activeInWindow.size,
    },
    // Totals that are facts about now rather than about the window.
    //
    // **Floors, not totals, and bounded reads.** `collect()` here was a full
    // table scan per page load: correct at today's size, and at a hundred
    // thousand accounts it is the admin page failing on Convex's per-query
    // document limit — the one screen whose job is to tell you the product
    // is growing, breaking because it did. There is no count API, so this
    // takes one page and says honestly when it filled it, which is the same
    // floor language `noteCount` and the census already use.
    totals: {
      workspaces: await countUpTo(ctx, "workspaces"),
      users: await countUpTo(ctx, "users"),
    },
  };
}
