/**
 * THE TURNS PAGE OF THE STAFF CONSOLE: Tex's text turns, read from `agentTurns`
 * (`functions/lib/schema/agentTurns.ts`).
 *
 * Only texts count here: a row from the texting assistant whose kind is `one`
 * (a person's own texts) or `group` (a group chat). A row with no kind from the
 * texts client is a one-to-one text, since kinds were not kept before
 * 2026-10-24. Background jobs, routines and the app's own turns are left out.
 *
 * Staff only: `functions/admin.ts` calls `requireAdmin` before this, and the
 * handler is kept separate so it can be tested without a caller.
 *
 * Nothing here can return text a person wrote, because the table holds none:
 * names, counts, outcomes, durations and tool names. A workspace is named by
 * its slug and an account by its name or, failing that, its email, which the
 * rest of the console already shows staff.
 *
 * "Typical" is the median and "slowest 1 in 20" the 95th percentile, both by
 * nearest rank (`percentile` in `agentReport.ts`). A window is read through the
 * `by_at` index, newest first, and capped at `CONSOLE_TURNS_READ` rows; past
 * that the answer says `truncated` rather than pretending to be complete.
 * Turns are kept 30 days, so the 90-day window simply holds what exists.
 */

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { dayKey } from "../usage";
import { percentile } from "./agentReport";
import { newBudget, ownersOf } from "./aiCostsRead";

/** The page's windows. Anything else asked for is the default. */
export const CONSOLE_TURN_WINDOWS = [1, 7, 30, 90] as const;
export const CONSOLE_DEFAULT_DAYS = 30;
/** Rows read per window, held well under Convex's 8 MiB read. */
export const CONSOLE_TURNS_READ = 2_000;
/** Reviews read for the handed-back share. */
export const CONSOLE_REVIEWS_READ = 2_000;
/** How far past now the window's end may reach: the client's minute, and clock skew. */
const TO_SLACK_MS = 60_000;
export const CONSOLE_RECENT = 40;
/** Owner rows read per workspace when naming who it belongs to. */
const OWNER_ROWS_READ = 50;
/** Longest search the page sends. */
const QUERY_MAX = 64;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

type TextKind = "one" | "group";

/** The text turn's kind, or null when the row is not a text turn. */
function textKindOf(row: Doc<"agentTurns">): TextKind | null {
  if (row.client !== "texts") return null;
  const kind = row.kind ?? "one";
  return kind === "one" || kind === "group" ? kind : null;
}

/** The nearest of the page's windows; anything else is the default. */
export function clampConsoleDays(days: unknown): number {
  return typeof days === "number" && (CONSOLE_TURN_WINDOWS as readonly number[]).includes(days)
    ? days
    : CONSOLE_DEFAULT_DAYS;
}

/** The search box's text: trimmed, one leading @ stripped, lowercase, at most 64 characters. */
export function normalizeConsoleQuery(q: unknown): string {
  if (typeof q !== "string") return "";
  return q.trim().replace(/^@/, "").trim().toLowerCase().slice(0, QUERY_MAX);
}

/** A turn is troubled when it did not answer, or any of its tool calls failed. */
function isTroubled(row: Doc<"agentTurns">): boolean {
  return row.outcome !== "answered" || row.trace.some((step) => step.kind === "tool" && !step.ok);
}

/** Handed back: the reviewer scored its independence 4 or below, or it said it could not do the task first. */
export function isHandedBack(row: Doc<"texReviewScores">): boolean {
  return row.independence <= 4 || (row.signals ?? []).includes("cant_first");
}

function spread(values: number[]): { p50: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
}

const traceEntry = v.object({
  kind: v.union(v.literal("model"), v.literal("tool"), v.literal("router"), v.literal("fallback")),
  tool: v.optional(v.string()),
  action: v.optional(v.string()),
  model: v.optional(v.string()),
  ok: v.boolean(),
  ms: v.number(),
});

export const consoleTurnsValidator = v.object({
  days: v.number(),
  /** A window or the reviews held more rows than were read. */
  truncated: v.boolean(),
  turns: v.number(),
  answered: v.number(),
  exhausted: v.number(),
  failed: v.number(),
  oneToOne: v.number(),
  group: v.number(),
  p50Ms: v.number(),
  p95Ms: v.number(),
  /** Null when the window before has no text turns. */
  priorP50Ms: v.union(v.number(), v.null()),
  /** Hourly for a one-day window, daily otherwise; oldest first, zero-filled. */
  series: v.array(v.object({ label: v.string(), turns: v.number(), p50: v.number(), p95: v.number() })),
  where: v.object({ modelMs: v.number(), toolMs: v.number(), otherMs: v.number() }),
  hurt: v.object({
    /** Share of turns that did not answer or had a failed tool call; null with no turns. */
    troubledShare: v.union(v.number(), v.null()),
    p95Ms: v.number(),
    /** Share of the window's scored reviews that were handed back; null with none. */
    handedBackShare: v.union(v.number(), v.null()),
    /** Reviews read for `handedBackShare`. */
    reviewed: v.number(),
  }),
  /** Answered turns from a person's own texts (kind one). */
  answeredOne: v.number(),
  /** Turns that matched the filters, before the newest-first cap. */
  recentTotal: v.number(),
  recent: v.array(
    v.object({
      id: v.string(),
      at: v.number(),
      workspace: v.union(v.string(), v.null()),
      person: v.union(v.string(), v.null()),
      group: v.boolean(),
      model: v.string(),
      outcome: v.union(v.literal("answered"), v.literal("exhausted"), v.literal("failed")),
      rounds: v.number(),
      ms: v.number(),
      waitMs: v.union(v.number(), v.null()),
      modelMs: v.number(),
      toolMs: v.number(),
      inputTokens: v.number(),
      outputTokens: v.number(),
      costMicroUsd: v.union(v.number(), v.null()),
      trace: v.array(traceEntry),
    }),
  ),
});

export type ConsoleTurns = Infer<typeof consoleTurnsValidator>;

export interface ConsoleTurnsArgs {
  days?: number;
  end?: "all" | "trouble";
  q?: string;
  to?: number;
}

async function turnsBetween(
  ctx: QueryCtx,
  from: number,
  to: number,
): Promise<{ rows: Doc<"agentTurns">[]; truncated: boolean }> {
  const rows = await ctx.db
    .query("agentTurns")
    .withIndex("by_at", (q) => q.gt("at", from).lte("at", to))
    .order("desc")
    .take(CONSOLE_TURNS_READ + 1);
  return { rows: rows.slice(0, CONSOLE_TURNS_READ), truncated: rows.length > CONSOLE_TURNS_READ };
}

interface Who {
  slug: string | null;
  /** The owner's name, trimmed; null when there is none. */
  name: string | null;
  /** The owner's email; null when there is none. */
  email: string | null;
}

/** Names the workspace and its first owner. The caller caches per workspace. */
async function whoOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Who> {
  const workspace = await ctx.db.get(workspaceId);
  const owners = await ownersOf(ctx, workspaceId, newBudget(OWNER_ROWS_READ));
  const owner = owners.length === 0 ? null : await ctx.db.get(owners[0]);
  const name = owner?.name?.trim() ?? "";
  return {
    slug: workspace?.slug ?? null,
    name: name === "" ? null : name,
    email: owner?.email ?? null,
  };
}

export async function consoleTurnsHandler(
  ctx: QueryCtx,
  args: ConsoleTurnsArgs,
  now: number = Date.now(),
): Promise<ConsoleTurns> {
  const days = clampConsoleDays(args.days);
  const windowMs = days * DAY_MS;
  const windowEnd = typeof args.to === "number" && Number.isFinite(args.to) ? Math.min(args.to, now + TO_SLACK_MS) : now;
  const end = args.end === "trouble" ? "trouble" : "all";
  const needle = normalizeConsoleQuery(args.q);

  const currentRead = await turnsBetween(ctx, windowEnd - windowMs, windowEnd);
  const priorRead = await turnsBetween(ctx, windowEnd - 2 * windowMs, windowEnd - windowMs);
  const current = currentRead.rows.flatMap((row) => {
    const kind = textKindOf(row);
    return kind === null ? [] : [{ row, kind }];
  });
  const prior = priorRead.rows.filter((row) => textKindOf(row) !== null);

  const currentSpread = spread(current.map((turn) => turn.row.ms));
  const priorSpread = spread(prior.map((row) => row.ms));

  // Buckets: hours for one day, days otherwise.
  const hourly = days === 1;
  const step = hourly ? HOUR_MS : DAY_MS;
  const count = hourly ? 24 : days;
  const bucketStart = hourly ? Math.floor(windowEnd / HOUR_MS) * HOUR_MS : Math.floor(windowEnd / DAY_MS) * DAY_MS;
  const bucketMs: number[][] = Array.from({ length: count }, () => []);
  for (const { row } of current) {
    const index = count - 1 - Math.floor((bucketStart - Math.floor(row.at / step) * step) / step);
    if (index >= 0 && index < count) bucketMs[index].push(row.ms);
  }
  const series = bucketMs.map((values, index) => {
    const start = bucketStart - (count - 1 - index) * step;
    const label = hourly ? `${new Date(start).toISOString().slice(11, 13)}:00` : dayKey(start);
    return { label, turns: values.length, ...spread(values) };
  });

  const counts = { answered: 0, exhausted: 0, failed: 0, oneToOne: 0, group: 0, answeredOne: 0 };
  let modelMs = 0;
  let toolMs = 0;
  let otherMs = 0;
  let troubled = 0;
  for (const { row, kind } of current) {
    if (row.outcome === "answered") counts.answered += 1;
    else if (row.outcome === "exhausted") counts.exhausted += 1;
    else counts.failed += 1;
    if (kind === "one") counts.oneToOne += 1;
    else counts.group += 1;
    if (row.outcome === "answered" && kind === "one") counts.answeredOne += 1;
    modelMs += row.modelMs;
    toolMs += row.toolMs;
    otherMs += Math.max(0, row.ms - row.modelMs - row.toolMs);
    if (isTroubled(row)) troubled += 1;
  }

  const reviewRead = await ctx.db
    .query("texReviewScores")
    .withIndex("by_at", (q) => q.gt("at", windowEnd - windowMs).lte("at", windowEnd))
    .order("desc")
    .take(CONSOLE_REVIEWS_READ + 1);
  const reviews = reviewRead.slice(0, CONSOLE_REVIEWS_READ);
  const handedBack = reviews.filter(isHandedBack).length;

  // The filters, then the newest-first cap. Names are looked up once per workspace.
  const whoCache = new Map<Id<"workspaces">, Who>();
  const who = async (workspaceId: Id<"workspaces">): Promise<Who> => {
    const hit = whoCache.get(workspaceId);
    if (hit !== undefined) return hit;
    const found = await whoOf(ctx, workspaceId);
    whoCache.set(workspaceId, found);
    return found;
  };
  const matched: { row: Doc<"agentTurns">; kind: TextKind; who: Who }[] = [];
  for (const turn of current) {
    if (end === "trouble" && turn.row.outcome === "answered") continue;
    const owner = await who(turn.row.workspaceId);
    if (needle !== "") {
      const hit = [owner.slug, owner.name, owner.email].some((field) => field !== null && field.toLowerCase().includes(needle));
      if (!hit) continue;
    }
    matched.push({ ...turn, who: owner });
  }

  return {
    days,
    truncated: currentRead.truncated || priorRead.truncated || reviewRead.length > CONSOLE_REVIEWS_READ,
    turns: current.length,
    answered: counts.answered,
    exhausted: counts.exhausted,
    failed: counts.failed,
    oneToOne: counts.oneToOne,
    group: counts.group,
    p50Ms: currentSpread.p50,
    p95Ms: currentSpread.p95,
    priorP50Ms: prior.length === 0 ? null : priorSpread.p50,
    series,
    where: { modelMs, toolMs, otherMs },
    hurt: {
      troubledShare: current.length === 0 ? null : troubled / current.length,
      p95Ms: currentSpread.p95,
      handedBackShare: reviews.length === 0 ? null : handedBack / reviews.length,
      reviewed: reviews.length,
    },
    answeredOne: counts.answeredOne,
    recentTotal: matched.length,
    recent: matched.slice(0, CONSOLE_RECENT).map(({ row, kind, who: owner }) => ({
      id: row._id,
      at: row.at,
      workspace: owner.slug,
      person: owner.name ?? owner.email,
      group: kind === "group",
      model: row.model,
      outcome: row.outcome,
      rounds: row.rounds,
      ms: row.ms,
      waitMs: row.waitMs ?? null,
      modelMs: row.modelMs,
      toolMs: row.toolMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costMicroUsd: row.costMicroUsd ?? null,
      trace: row.trace.map((step) => ({
        kind: step.kind,
        ...(step.tool === undefined ? {} : { tool: step.tool }),
        ...(step.action === undefined ? {} : { action: step.action }),
        ...(step.model === undefined ? {} : { model: step.model }),
        ok: step.ok,
        ms: step.ms,
      })),
    })),
  };
}
