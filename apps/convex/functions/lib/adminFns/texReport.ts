/**
 * THE TEX TAB'S FIGURES: how many texts Tex handles and what they cost, read
 * from `agentTurns`, and every scored conversation in the window, read from
 * `texReviewScores`, for the tab to slice (`docs/decisions/observability/
 * tex-telemetry.md`).
 *
 * Asked for by the owner, 2026-10-24 ("how many texts we are processing,
 * categorization of tasks ... tokens ... pricing, tool usage, as well as the
 * scores"), drawn from the approved dashboard concept. Staff only:
 * `functions/adminTex.ts` calls `requireAdmin` before this.
 *
 * Nothing here can return a word anybody wrote: the turn log holds names and
 * counts, and a scores row holds numbers and codes and names nobody. The
 * review rows go to the tab whole because slicing them by any field is the
 * point (the Explore view), and a row cannot be traced back to a person.
 *
 * Both reads are capped and say `truncated` past the cap rather than
 * pretending to be complete.
 */

import { v, type Infer } from "convex/values";
import type { Doc } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { dayKey } from "../usage";

/** Scores are kept 90 days and turns 30; the turn figures stop at 30. */
export const TEX_REPORT_WINDOWS = [7, 30, 90] as const;
export const TURN_DAYS_KEPT = 30;
export const MAX_TEX_TURNS_READ = 4_000;
export const MAX_REVIEWS_READ = 3_000;

const DAY_MS = 86_400_000;

export function clampTexDays(days: unknown): number {
  if (typeof days !== "number" || !Number.isFinite(days)) return 30;
  return TEX_REPORT_WINDOWS.reduce((best, w) => (Math.abs(w - days) < Math.abs(best - days) ? w : best), 30);
}

const KINDS = ["one", "group", "job", "routine", "app", "older"] as const;
type KindKey = (typeof KINDS)[number];

const reviewRow = v.object({
  at: v.number(),
  kind: v.union(v.literal("one"), v.literal("group")),
  reason: v.string(),
  goal: v.number(),
  independence: v.number(),
  turns: v.number(),
  friendly: v.number(),
  calm: v.number(),
  task: v.union(v.string(), v.null()),
  signals: v.array(v.string()),
  texts: v.union(v.number(), v.null()),
  who: v.union(v.literal("staff"), v.literal("new"), v.literal("other"), v.null()),
  costMicroUsd: v.union(v.number(), v.null()),
  thought: v.union(v.boolean(), v.null()),
});

export const texReportValidator = v.object({
  days: v.number(),
  /** The window the turn figures cover: the asked window, at most `TURN_DAYS_KEPT`. */
  turnDays: v.number(),
  turns: v.object({
    truncated: v.boolean(),
    total: v.number(),
    /** Turns by where they came from; `older` is a turn logged before kinds were kept. */
    byKind: v.object({ one: v.number(), group: v.number(), job: v.number(), routine: v.number(), app: v.number(), older: v.number() }),
    answered: v.number(),
    exhausted: v.number(),
    failed: v.number(),
    /** List-price spend of the turns that carried one (since 2026-10-24). */
    costMicroUsd: v.number(),
    priced: v.number(),
    /** Oldest first, zero-filled. */
    byDay: v.array(v.object({ day: v.string(), turns: v.number(), costMicroUsd: v.number() })),
    models: v.array(
      v.object({
        model: v.string(),
        turns: v.number(),
        inputTokens: v.number(),
        outputTokens: v.number(),
        cacheReadTokens: v.number(),
        costMicroUsd: v.number(),
      }),
    ),
    tools: v.array(v.object({ tool: v.string(), calls: v.number(), failed: v.number() })),
  }),
  reviewsTruncated: v.boolean(),
  /** Every scored conversation in the window, newest first. */
  reviews: v.array(reviewRow),
});

export type TexReport = Infer<typeof texReportValidator>;

function kindOf(row: Doc<"agentTurns">): KindKey {
  return row.kind ?? "older";
}

export async function texReportHandler(ctx: QueryCtx, args: { days?: number }, now: number = Date.now()): Promise<TexReport> {
  const days = clampTexDays(args.days);
  const turnDays = Math.min(days, TURN_DAYS_KEPT);

  const turnRows = await ctx.db
    .query("agentTurns")
    .withIndex("by_at", (q) => q.gt("at", now - turnDays * DAY_MS).lte("at", now))
    .order("desc")
    .take(MAX_TEX_TURNS_READ + 1);
  const turns = turnRows.slice(0, MAX_TEX_TURNS_READ);

  const byKind = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<KindKey, number>;
  const outcomes = { answered: 0, exhausted: 0, failed: 0 };
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const byDay = Array.from({ length: turnDays }, (_, index) => ({ day: dayKey(dayStart - (turnDays - 1 - index) * DAY_MS), turns: 0, costMicroUsd: 0 }));
  const models = new Map<string, { turns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costMicroUsd: number }>();
  const tools = new Map<string, { calls: number; failed: number }>();
  let cost = 0;
  let priced = 0;
  for (const row of turns) {
    byKind[kindOf(row)] += 1;
    outcomes[row.outcome] += 1;
    const index = turnDays - 1 - Math.floor((dayStart - Math.floor(row.at / DAY_MS) * DAY_MS) / DAY_MS);
    const bucket = byDay[index];
    if (bucket) bucket.turns += 1;
    if (row.costMicroUsd !== undefined) {
      cost += row.costMicroUsd;
      priced += 1;
      if (bucket) bucket.costMicroUsd += row.costMicroUsd;
    }
    // A turn with each model's own counts is split by them; an older one is all its own model's.
    const used = row.models ?? [
      { model: row.model, inputTokens: row.inputTokens, outputTokens: row.outputTokens, cacheReadTokens: row.cacheReadTokens ?? 0, cacheWriteTokens: 0, costMicroUsd: row.costMicroUsd ?? 0 },
    ];
    for (const part of used) {
      const entry = models.get(part.model) ?? { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costMicroUsd: 0 };
      entry.turns += 1;
      entry.inputTokens += part.inputTokens;
      entry.outputTokens += part.outputTokens;
      entry.cacheReadTokens += part.cacheReadTokens;
      entry.costMicroUsd += part.costMicroUsd;
      models.set(part.model, entry);
    }
    for (const step of row.trace) {
      if (step.kind !== "tool" || step.tool === undefined) continue;
      const tool = tools.get(step.tool) ?? { calls: 0, failed: 0 };
      tool.calls += 1;
      if (!step.ok) tool.failed += 1;
      tools.set(step.tool, tool);
    }
  }

  const reviewRows = await ctx.db
    .query("texReviewScores")
    .withIndex("by_at", (q) => q.gt("at", now - days * DAY_MS).lte("at", now))
    .order("desc")
    .take(MAX_REVIEWS_READ + 1);
  const reviews = reviewRows.slice(0, MAX_REVIEWS_READ).map((row) => ({
    at: row.at,
    kind: row.kind,
    reason: row.reason,
    goal: row.goal,
    independence: row.independence,
    turns: row.turns,
    friendly: row.friendly,
    calm: row.calm,
    task: row.task ?? null,
    signals: row.signals ?? [],
    texts: row.texts ?? null,
    who: row.who ?? null,
    costMicroUsd: row.costMicroUsd ?? null,
    thought: row.thought ?? null,
  }));

  return {
    days,
    turnDays,
    turns: {
      truncated: turnRows.length > MAX_TEX_TURNS_READ,
      total: turns.length,
      byKind,
      ...outcomes,
      costMicroUsd: cost,
      priced,
      byDay,
      models: [...models.entries()].map(([model, entry]) => ({ model, ...entry })).sort((a, b) => b.costMicroUsd - a.costMicroUsd || b.turns - a.turns),
      tools: [...tools.entries()].map(([tool, entry]) => ({ tool, ...entry })).sort((a, b) => b.calls - a.calls),
    },
    reviewsTruncated: reviewRows.length > MAX_REVIEWS_READ,
    reviews,
  };
}
