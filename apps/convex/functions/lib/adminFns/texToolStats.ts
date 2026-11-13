/**
 * THE TEX ARCHITECTURE LAB'S TOOL STATS: per tool, and per tool action, how
 * many calls ran over a window, how many failed, the median time, and the
 * reasons the failures gave (`agentTurns` trace entries, joined with
 * `texToolFailures`). Staff only; the page is the Lab's Tools tab.
 *
 * Counts and names only. A held call is left out of the counts: it was held
 * for the person's yes and never ran, so it is not a call that failed.
 */

import { v, type Infer } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";

/** Convex's read limits: a bigger window is cut and says so, never read past. */
export const MAX_TURNS_READ = 2_500;
export const MAX_FAILURES_READ = 5_000;
/** The most reasons a tool row carries. */
export const MAX_WHY_PER_TOOL = 5;

const DAY_MS = 86_400_000;

export const toolStatsValidator = v.object({
  days: v.number(),
  truncated: v.boolean(),
  turns: v.number(),
  calls: v.number(),
  failuresTotal: v.number(),
  rows: v.array(
    v.object({
      /** `tool` for a tool's row, `tool.action` for one of its actions. */
      key: v.string(),
      tool: v.string(),
      action: v.union(v.string(), v.null()),
      calls: v.number(),
      errors: v.number(),
      medianMs: v.union(v.number(), v.null()),
      /** Tool rows only: the most common failure reasons. Action rows carry none. */
      why: v.array(v.object({ why: v.string(), cause: v.string(), count: v.number() })),
    }),
  ),
});

export type ToolStats = Infer<typeof toolStatsValidator>;

/**
 * The middle sample of a list of durations: `b[floor(n / 2)]` of the sorted
 * list, so for an even count it is the upper of the two middle values.
 */
function medianOf(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export async function toolStatsReport(ctx: QueryCtx, days: number, now: number): Promise<ToolStats> {
  const since = now - days * DAY_MS;
  const turns = await ctx.db
    .query("agentTurns")
    .withIndex("by_at", (q) => q.gt("at", since).lte("at", now))
    .order("desc")
    .take(MAX_TURNS_READ + 1);
  const readTurns = turns.slice(0, MAX_TURNS_READ);

  const counts = new Map<string, { tool: string; action: string | null; calls: number; errors: number; samples: number[] }>();
  const tally = (key: string, tool: string, action: string | null, ok: boolean, ms: number) => {
    const row = counts.get(key) ?? { tool, action, calls: 0, errors: 0, samples: [] };
    row.calls += 1;
    if (!ok) row.errors += 1;
    row.samples.push(ms);
    counts.set(key, row);
  };
  // Counted by the name Tex called (`write`), not the older tool it ran as (`write_note`), so the rows line up with the
  // Lab's tool list; `ranAs` lets a failure, which names the tool that ran, find its row.
  const ranAs = new Map<string, string>();
  for (const turn of readTurns) {
    for (const entry of turn.trace) {
      if (entry.kind !== "tool" || entry.tool === undefined || entry.held === true) continue;
      const name = entry.six ?? entry.tool;
      if (entry.six !== undefined) ranAs.set(entry.tool, entry.six);
      tally(name, name, null, entry.ok, entry.ms);
      if (entry.action !== undefined) tally(`${name}.${entry.action}`, name, entry.action, entry.ok, entry.ms);
    }
  }

  const failures = await ctx.db
    .query("texToolFailures")
    .withIndex("by_at", (q) => q.gt("at", since).lte("at", now))
    .order("desc")
    .take(MAX_FAILURES_READ + 1);
  const readFailures = failures.slice(0, MAX_FAILURES_READ);
  const reasons = new Map<string, Map<string, { why: string; cause: string; count: number }>>();
  for (const failure of readFailures) {
    const tool = ranAs.get(failure.tool) ?? failure.tool;
    const byWhy = reasons.get(tool) ?? new Map<string, { why: string; cause: string; count: number }>();
    const reasonKey = `${failure.cause}\u0000${failure.why}`;
    const reason = byWhy.get(reasonKey) ?? { why: failure.why, cause: failure.cause, count: 0 };
    reason.count += 1;
    byWhy.set(reasonKey, reason);
    reasons.set(tool, byWhy);
  }

  const rows = [...counts.entries()].map(([key, row]) => ({
    key,
    tool: row.tool,
    action: row.action,
    calls: row.calls,
    errors: row.errors,
    medianMs: medianOf(row.samples),
    why: row.action === null
      ? [...(reasons.get(row.tool)?.values() ?? [])].sort((a, b) => b.count - a.count || a.why.localeCompare(b.why)).slice(0, MAX_WHY_PER_TOOL)
      : [],
  }));
  rows.sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));

  const calls = rows.reduce((total, row) => total + (row.action === null ? row.calls : 0), 0);
  return { days, truncated: turns.length > MAX_TURNS_READ, turns: readTurns.length, calls, failuresTotal: readFailures.length, rows };
}
