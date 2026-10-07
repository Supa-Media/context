/**
 * THE AGENT TAB'S FIGURES: how fast the agent answers, how often it gets stuck,
 * and which tools it calls, read from `agentTurns` (`functions/agentTurns.ts`).
 *
 * Asked for by the owner, 2026-10-07 ("see how much time and what tool calls
 * are being made ... audit the agent"), drawn from the approved Agent tab
 * mockup. Staff only: `functions/admin.ts` calls `requireAdmin` before this.
 *
 * Nothing here can return text a person wrote, because the table holds none:
 * names, outcomes, durations and counts. A workspace is named by its slug,
 * which the rest of the console already shows staff.
 *
 * "Typical" is the median and "slowest 1 in 20" the 95th percentile, both by
 * nearest rank over the turns in the window. A window is read through the
 * `by_at` index, newest first, and capped at `MAX_TURNS_READ`; past that the
 * answer says `truncated` rather than pretending to be complete.
 */

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { dayKey } from "../usage";

/** Turns are kept 30 days, so no window can usefully be longer. */
export const AGENT_REPORT_WINDOWS = [1, 7, 30] as const;
export const MAX_TURNS_READ = 4_000;
export const RECENT_TURNS = 40;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type AgentClientFilter = "all" | "texts" | "app";

export function clampAgentDays(days: unknown): number {
  if (typeof days !== "number" || !Number.isFinite(days)) return 7;
  return AGENT_REPORT_WINDOWS.reduce((best, w) => (Math.abs(w - days) < Math.abs(best - days) ? w : best), 7);
}

/** Nearest-rank percentile of an ascending list; 0 for an empty one. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function spread(values: number[]): { p50: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
}

const traceEntry = v.object({
  kind: v.union(v.literal("model"), v.literal("tool")),
  tool: v.optional(v.string()),
  ok: v.boolean(),
  ms: v.number(),
});

export const agentReportValidator = v.object({
  days: v.number(),
  client: v.union(v.literal("all"), v.literal("texts"), v.literal("app")),
  /** The slug asked for, when it named a workspace that exists. */
  workspace: v.union(v.string(), v.null()),
  /** The window held more turns than were read. */
  truncated: v.boolean(),
  current: v.object({
    turns: v.number(),
    workspaces: v.number(),
    p50: v.number(),
    p95: v.number(),
    answered: v.number(),
    exhausted: v.number(),
    failed: v.number(),
    totalMs: v.number(),
    modelMs: v.number(),
    toolMs: v.number(),
    toolCalls: v.number(),
  }),
  prior: v.object({ turns: v.number(), p50: v.number(), p95: v.number() }),
  /** Hourly for a one-day window, daily otherwise; oldest first, zero-filled. */
  buckets: v.array(v.object({ label: v.string(), turns: v.number(), p50: v.number(), p95: v.number() })),
  models: v.array(v.object({ provider: v.string(), model: v.string(), turns: v.number(), p50: v.number() })),
  tools: v.array(
    v.object({ tool: v.string(), calls: v.number(), failed: v.number(), p50: v.number(), p95: v.number() }),
  ),
  recent: v.array(
    v.object({
      id: v.string(),
      at: v.number(),
      workspace: v.union(v.string(), v.null()),
      client: v.union(v.literal("texts"), v.literal("app")),
      provider: v.string(),
      model: v.string(),
      outcome: v.union(v.literal("answered"), v.literal("exhausted"), v.literal("failed")),
      rounds: v.number(),
      ms: v.number(),
      modelMs: v.number(),
      toolMs: v.number(),
      inputTokens: v.number(),
      outputTokens: v.number(),
      trace: v.array(traceEntry),
    }),
  ),
});

export type AgentReport = Infer<typeof agentReportValidator>;

async function turnsBetween(
  ctx: QueryCtx,
  from: number,
  to: number,
  workspaceId: Id<"workspaces"> | null,
): Promise<{ rows: Doc<"agentTurns">[]; truncated: boolean }> {
  const query =
    workspaceId === null
      ? ctx.db.query("agentTurns").withIndex("by_at", (q) => q.gt("at", from).lte("at", to))
      : ctx.db
          .query("agentTurns")
          .withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId).gt("at", from).lte("at", to));
  const rows = await query.order("desc").take(MAX_TURNS_READ + 1);
  return { rows: rows.slice(0, MAX_TURNS_READ), truncated: rows.length > MAX_TURNS_READ };
}

export async function agentReportHandler(
  ctx: QueryCtx,
  args: { days?: number; client?: AgentClientFilter; workspace?: string },
  now: number = Date.now(),
): Promise<AgentReport> {
  const days = clampAgentDays(args.days);
  const client: AgentClientFilter = args.client === "texts" || args.client === "app" ? args.client : "all";
  const slug = typeof args.workspace === "string" ? args.workspace.trim().replace(/^@/, "").toLowerCase() : "";
  const named =
    slug === "" ? null : await ctx.db.query("workspaces").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
  const workspaceId = named?._id ?? null;

  const windowMs = days * DAY_MS;
  const keep = (row: Doc<"agentTurns">) => client === "all" || row.client === client;
  const currentRead = await turnsBetween(ctx, now - windowMs, now, workspaceId);
  const priorRead = await turnsBetween(ctx, now - 2 * windowMs, now - windowMs, workspaceId);
  // A slug that names nothing matches no turns, rather than every turn.
  const current = slug !== "" && named === null ? [] : currentRead.rows.filter(keep);
  const prior = slug !== "" && named === null ? [] : priorRead.rows.filter(keep);

  const currentSpread = spread(current.map((row) => row.ms));
  const priorSpread = spread(prior.map((row) => row.ms));

  // Buckets: hours for one day, days otherwise.
  const hourly = days === 1;
  const step = hourly ? HOUR_MS : DAY_MS;
  const count = hourly ? 24 : days;
  const bucketStart = hourly ? Math.floor(now / HOUR_MS) * HOUR_MS : Math.floor(now / DAY_MS) * DAY_MS;
  const bucketMs: number[][] = Array.from({ length: count }, () => []);
  for (const row of current) {
    const index = count - 1 - Math.floor((bucketStart - Math.floor(row.at / step) * step) / step);
    if (index >= 0 && index < count) bucketMs[index].push(row.ms);
  }
  const buckets = bucketMs.map((values, index) => {
    const start = bucketStart - (count - 1 - index) * step;
    const label = hourly ? `${new Date(start).toISOString().slice(11, 13)}:00` : dayKey(start);
    return { label, turns: values.length, ...spread(values) };
  });

  const byModel = new Map<string, { provider: string; model: string; ms: number[] }>();
  const byTool = new Map<string, { failed: number; ms: number[] }>();
  let modelMs = 0;
  let toolMs = 0;
  let totalMs = 0;
  let toolCalls = 0;
  const outcomes = { answered: 0, exhausted: 0, failed: 0 };
  const workspaces = new Set<string>();
  for (const row of current) {
    outcomes[row.outcome] += 1;
    workspaces.add(row.workspaceId);
    totalMs += row.ms;
    modelMs += row.modelMs;
    toolMs += row.toolMs;
    const modelKey = `${row.provider}\u0000${row.model}`;
    const entry = byModel.get(modelKey) ?? { provider: row.provider, model: row.model, ms: [] };
    entry.ms.push(row.ms);
    byModel.set(modelKey, entry);
    for (const step of row.trace) {
      if (step.kind !== "tool" || step.tool === undefined) continue;
      toolCalls += 1;
      const tool = byTool.get(step.tool) ?? { failed: 0, ms: [] };
      tool.ms.push(step.ms);
      if (!step.ok) tool.failed += 1;
      byTool.set(step.tool, tool);
    }
  }

  const slugs = new Map<string, string | null>();
  const recentRows = current.slice(0, RECENT_TURNS);
  for (const row of recentRows) {
    if (!slugs.has(row.workspaceId)) slugs.set(row.workspaceId, (await ctx.db.get(row.workspaceId))?.slug ?? null);
  }

  return {
    days,
    client,
    workspace: named === null ? null : named.slug,
    truncated: currentRead.truncated || priorRead.truncated,
    current: {
      turns: current.length,
      workspaces: workspaces.size,
      ...currentSpread,
      ...outcomes,
      totalMs,
      modelMs,
      toolMs,
      toolCalls,
    },
    prior: { turns: prior.length, ...priorSpread },
    buckets,
    models: [...byModel.values()]
      .map((entry) => ({ provider: entry.provider, model: entry.model, turns: entry.ms.length, p50: spread(entry.ms).p50 }))
      .sort((a, b) => b.turns - a.turns),
    tools: [...byTool.entries()]
      .map(([tool, entry]) => ({ tool, calls: entry.ms.length, failed: entry.failed, ...spread(entry.ms) }))
      .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
    recent: recentRows.map((row) => ({
      id: row._id,
      at: row.at,
      workspace: slugs.get(row.workspaceId) ?? null,
      client: row.client,
      provider: row.provider,
      model: row.model,
      outcome: row.outcome,
      rounds: row.rounds,
      ms: row.ms,
      modelMs: row.modelMs,
      toolMs: row.toolMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      trace: row.trace,
    })),
  };
}
