/**
 * THE TEX ARCHITECTURE LAB'S TOOL STATS: per tool, and per tool action, how
 * many calls ran over a window, how many failed, the median time, and the
 * reasons the failures gave (`agentTurns` trace entries, joined with
 * `texToolFailures`). Staff only; the page is the Lab's Tools tab.
 *
 * Counts and names only. A held call is left out of the counts: it was held
 * for the person's yes and never ran, so it is not a call that failed. A
 * designed send-back (`ask`, a page asking for its scene) did run, and it is
 * a call that worked: it is not an error even when the trace also says `ok: false`.
 */

import { v, type Infer } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
import { TOOL_CHAR_LIMIT, TOOL_CHAR_LIMITS, rateError } from "@context/tex/src/toolRules.cjs";

/** Convex's read limits: a bigger window is cut and says so, never read past. */
export const MAX_TURNS_READ = 2_500;
export const MAX_FAILURES_READ = 5_000;
/** The most reasons a tool row carries. */
export const MAX_WHY_PER_TOOL = 5;

const DAY_MS = 86_400_000;


/** Failure causes that mean the model called a tool or an action its turn was not given (rule 1). */
const NOT_HELD = new Set(["not_offered", "no_such_action"]);
/** The 1:1 chat's kinds of turn: rule 1 asks them all to see one tool list. A group chat's turns are `group`. */
const ONE_TO_ONE = new Set(["one", "job", "routine"]);
const MAX_WORST = 8;

/**
 * THE FOUR TOOL RULES, AS PRODUCTION RAN THEM (Dev2, 2026-11-20; `packages/tex/src/toolRules.cjs`), for the Lab's
 * Tools tab and tex_dev's `tool_stats` (its `rules`). Counted from what each turn logged (the tool list its model was shown, each
 * call, each failure's reason), never estimated: a turn from before the list was logged counts for nothing here.
 */
export const toolRulesValidator = v.object({
  limit: v.number(),
  /** Tools with a budget of their own (send: 8,000), by name. */
  limits: v.optional(v.record(v.string(), v.number())),
  /** Turns that logged the tool list they were shown. */
  turnsWithList: v.number(),
  /** Rule 2: each tool's largest size seen, by the kind of turn it was shown in. */
  sizes: v.array(v.object({ tool: v.string(), kind: v.string(), chars: v.number() })),
  /** Rule 1: different whole lists, different forms of each tool, and the most lists one workspace's 1:1 turns saw. */
  lists: v.object({
    distinct: v.number(),
    byKind: v.array(v.object({ kind: v.string(), distinct: v.number(), turns: v.number() })),
    toolForms: v.array(v.object({ tool: v.string(), forms: v.number() })),
    mostInOneChat: v.number(),
  }),
  /** Rule 1's cost: failures that were calls to a tool or action the turn was not given. */
  notHeld: v.number(),
  /** Rule 3: plain note writes that changed one of Tex's own state files, by file. */
  stateWrites: v.array(v.object({ file: v.string(), count: v.number() })),
  /** Rule 4: failures by whether their reason says what to do next, and the commonest that don't. */
  errors: v.object({
    actionable: v.number(),
    partial: v.number(),
    not: v.number(),
    worst: v.array(v.object({ why: v.string(), count: v.number(), rating: v.string() })),
  }),
});

export type ToolRules = Infer<typeof toolRulesValidator>;

export const toolStatsValidator = v.object({
  days: v.number(),
  /** The four tool rules over the same window (`toolRulesOf`). Optional so an older client's check still passes. */
  rules: v.optional(toolRulesValidator),
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

type TurnRow = { workspaceId: string; kind?: string; trace: Array<{ kind: string; state?: string }>; tools?: { list: string; each: Array<{ name: string; chars: number; print: string }> } };

export function toolRulesOf(turns: TurnRow[], failures: Array<{ cause: string; why: string }>): ToolRules {
  const withList = turns.filter((turn) => turn.tools !== undefined);
  const sizes = new Map<string, { tool: string; kind: string; chars: number }>();
  const forms = new Map<string, Set<string>>();
  const byKind = new Map<string, { lists: Set<string>; turns: number }>();
  const byChat = new Map<string, Set<string>>();
  for (const turn of withList) {
    const shown = turn.tools!;
    const kind = turn.kind ?? "unknown";
    const row = byKind.get(kind) ?? { lists: new Set<string>(), turns: 0 };
    row.lists.add(shown.list);
    row.turns += 1;
    byKind.set(kind, row);
    const chat = `${turn.workspaceId}:${ONE_TO_ONE.has(kind) ? "1:1" : kind}`;
    byChat.set(chat, (byChat.get(chat) ?? new Set<string>()).add(shown.list));
    for (const tool of shown.each) {
      const key = `${tool.name}\u0000${kind}`;
      const was = sizes.get(key);
      if (!was || was.chars < tool.chars) sizes.set(key, { tool: tool.name, kind, chars: tool.chars });
      forms.set(tool.name, (forms.get(tool.name) ?? new Set<string>()).add(tool.print));
    }
  }
  const stateWrites = new Map<string, number>();
  for (const turn of turns) for (const entry of turn.trace) if (entry.kind === "tool" && entry.state !== undefined) stateWrites.set(entry.state, (stateWrites.get(entry.state) ?? 0) + 1);
  const rated = { actionable: 0, partial: 0, not: 0 };
  const worst = new Map<string, { why: string; count: number; rating: string }>();
  for (const failure of failures) {
    const rating = rateError(failure.why);
    rated[rating] += 1;
    if (rating === "actionable") continue;
    const row = worst.get(failure.why) ?? { why: failure.why, count: 0, rating };
    row.count += 1;
    worst.set(failure.why, row);
  }
  return {
    limit: TOOL_CHAR_LIMIT,
    limits: TOOL_CHAR_LIMITS,
    turnsWithList: withList.length,
    sizes: [...sizes.values()].sort((a, b) => b.chars - a.chars || a.tool.localeCompare(b.tool)),
    lists: {
      distinct: new Set(withList.map((turn) => turn.tools!.list)).size,
      byKind: [...byKind.entries()].map(([kind, row]) => ({ kind, distinct: row.lists.size, turns: row.turns })).sort((a, b) => b.turns - a.turns),
      toolForms: [...forms.entries()].map(([tool, set]) => ({ tool, forms: set.size })).sort((a, b) => b.forms - a.forms || a.tool.localeCompare(b.tool)),
      mostInOneChat: Math.max(0, ...[...byChat.values()].map((set) => set.size)),
    },
    notHeld: failures.filter((failure) => NOT_HELD.has(failure.cause)).length,
    stateWrites: [...stateWrites.entries()].map(([file, count]) => ({ file, count })).sort((a, b) => b.count - a.count),
    errors: { ...rated, worst: [...worst.values()].sort((a, b) => b.count - a.count || a.why.localeCompare(b.why)).slice(0, MAX_WORST) },
  };
}

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
  // The action each older tool ran as, for its row's own reasons: a failure names only the tool that ran. A tool that ran
  // as more than one action keeps its reasons on the tool's row alone (null), never guessed onto one of them.
  const actionOf = new Map<string, string | null>();
  for (const turn of readTurns) {
    for (const entry of turn.trace) {
      if (entry.kind !== "tool" || entry.tool === undefined || entry.held === true) continue;
      const name = entry.six ?? entry.tool;
      if (entry.six !== undefined) ranAs.set(entry.tool, entry.six);
      const ok = entry.ok || entry.ask === true;
      tally(name, name, null, ok, entry.ms);
      if (entry.action !== undefined) {
        const key = `${name}.${entry.action}`;
        tally(key, name, entry.action, ok, entry.ms);
        // Only a call made as one of the six names its older tool apart; a bare `write` could be any of write's actions.
        if (entry.six !== undefined) actionOf.set(entry.tool, actionOf.has(entry.tool) && actionOf.get(entry.tool) !== key ? null : key);
      }
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
    const action = actionOf.get(failure.tool);
    if (typeof action === "string") {
      const byAction = reasons.get(action) ?? new Map<string, { why: string; cause: string; count: number }>();
      const own = byAction.get(reasonKey) ?? { why: failure.why, cause: failure.cause, count: 0 };
      own.count += 1;
      byAction.set(reasonKey, own);
      reasons.set(action, byAction);
    }
  }

  const rows = [...counts.entries()].map(([key, row]) => ({
    key,
    tool: row.tool,
    action: row.action,
    calls: row.calls,
    errors: row.errors,
    medianMs: medianOf(row.samples),
    why: [...(reasons.get(row.action === null ? row.tool : key)?.values() ?? [])].sort((a, b) => b.count - a.count || a.why.localeCompare(b.why)).slice(0, MAX_WHY_PER_TOOL),
  }));
  rows.sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));

  const calls = rows.reduce((total, row) => total + (row.action === null ? row.calls : 0), 0);
  const rules = toolRulesOf(readTurns as unknown as TurnRow[], readFailures);
  return { days, truncated: turns.length > MAX_TURNS_READ, turns: readTurns.length, calls, failuresTotal: readFailures.length, rows, rules };
}
