/**
 * "Why tools fail" on tex.lc/admin: the window's failed tool calls
 * (`texToolFailures`, anonymous rows), grouped by tool, cause and reason, and
 * counted by day, so a reason that keeps coming back is seen and a fix that
 * held shows as its line going quiet (Dev2, 2026-11-10).
 */

import { v, type Infer } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
import { dayKey } from "../usage";

export const MAX_TOOL_FAILURES_READ = 5_000;
/** The most reasons the page is sent: the rest are counted in `total`, never listed. */
export const MAX_REASONS = 40;

const DAY_MS = 86_400_000;

export const toolFailuresValidator = v.object({
  truncated: v.boolean(),
  total: v.number(),
  /** Oldest first, zero-filled, one per day of the window. */
  byDay: v.array(v.object({ day: v.string(), failures: v.number() })),
  /** Most first: each tool, cause and reason, how often, when last, and where it ran. */
  reasons: v.array(
    v.object({
      tool: v.string(),
      cause: v.string(),
      why: v.string(),
      count: v.number(),
      last: v.number(),
      kinds: v.array(v.string()),
    }),
  ),
});

export type ToolFailures = Infer<typeof toolFailuresValidator>;

export async function toolFailuresReport(ctx: QueryCtx, days: number, now: number): Promise<ToolFailures> {
  const rows = await ctx.db
    .query("texToolFailures")
    .withIndex("by_at", (q) => q.gt("at", now - days * DAY_MS).lte("at", now))
    .order("desc")
    .take(MAX_TOOL_FAILURES_READ + 1);
  const read = rows.slice(0, MAX_TOOL_FAILURES_READ);
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const byDay = Array.from({ length: days }, (_, index) => ({ day: dayKey(dayStart - (days - 1 - index) * DAY_MS), failures: 0 }));
  const index = new Map(byDay.map((entry, at) => [entry.day, at]));
  const groups = new Map<string, { tool: string; cause: string; why: string; count: number; last: number; kinds: Set<string> }>();
  for (const row of read) {
    const at = index.get(row.day);
    if (at !== undefined) byDay[at].failures += 1;
    const key = `${row.tool}\u0000${row.cause}\u0000${row.why}`;
    const group = groups.get(key) ?? { tool: row.tool, cause: row.cause, why: row.why, count: 0, last: 0, kinds: new Set<string>() };
    group.count += 1;
    group.last = Math.max(group.last, row.at);
    group.kinds.add(row.kind);
    groups.set(key, group);
  }
  const reasons = [...groups.values()]
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, MAX_REASONS)
    .map((group) => ({ ...group, kinds: [...group.kinds].sort() }));
  return { truncated: rows.length > MAX_TOOL_FAILURES_READ, total: read.length, byDay, reasons };
}
