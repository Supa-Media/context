/**
 * THE QUALITY FIGURES OF THE SEARCH TAB: did a search find what the person
 * wanted, and where in the results did they open it. Read from the quality
 * rows of `searchTimings` (`functions/searchTimings.ts`), which `searchReport`
 * has already read for the window.
 *
 * A quality row is one with `who`: the app's `screen` row, an AI client's
 * gateway row, Tex's gateway row. The four keys are `all`, `app`, `ai`, `tex`,
 * and each figure is a plain count or percentage over those rows only. A row
 * without `who` is a timing and is never counted here.
 *
 * Definitions, so the Search tab can say what it means:
 *  - found: the share of searches where a result was opened.
 *  - pos: where the first opened result was, of all searches (1, 2, 3, 4-5, 6+).
 *    The rest of the searches opened nothing.
 *  - next: of all searches, how many were searched again within a minute with
 *    nothing opened (`again`), and how many were given up on (nothing opened,
 *    not searched again).
 *  - ms: the median and 95th percentile of the time the search took.
 *  - foundBefore: found, over the previous window of the same length.
 *  - first (in series and byIndex): of the searches that found, the share that
 *    opened the first result.
 */

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { dayKey } from "../usage";
import { percentile } from "./agentReport";
import { meaningRowFor } from "../meaningFns/rows";

type Row = Doc<"searchTimings">;
type Key = "all" | "app" | "ai" | "tex";
const KEYS: readonly Key[] = ["all", "app", "ai", "tex"];
const ANSWERED_BY = ["fast", "index", "scan", "none", "failed"] as const;

/** A workspace is listed as a miss only once it has this many quality searches. */
export const MIN_QUALITY_SEARCHES = 10;
export const MISSES_SHOWN = 8;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const figuresValidator = v.object({
  n: v.number(),
  /** Percent of searches where a result was opened. */
  found: v.number(),
  /** Percent of searches, by the place opened: [1st, 2nd, 3rd, 4th-5th, 6th or later]. */
  pos: v.array(v.number()),
  /** Percent of searches: [searched again within a minute with nothing opened, given up on]. */
  next: v.array(v.number()),
  /** Milliseconds: [median, 95th percentile]. */
  ms: v.array(v.number()),
  /** Percent found in the previous window of the same length. */
  foundBefore: v.number(),
});

const bucketValidator = v.object({
  found: v.number(),
  /** Percent of the searches that found, where the first result was the one opened. */
  first: v.number(),
  p50: v.number(),
  p95: v.number(),
});

export const searchQualityValidator = v.object({
  all: figuresValidator,
  app: figuresValidator,
  ai: figuresValidator,
  tex: figuresValidator,
  /** Hourly for a one-day window, daily otherwise; oldest first, zero-filled. */
  series: v.array(
    v.object({ label: v.string(), all: bucketValidator, app: bucketValidator, ai: bucketValidator, tex: bucketValidator }),
  ),
  /** Quality searches that name the index which answered, in index order. */
  byIndex: v.array(
    v.object({
      answeredBy: v.union(
        v.literal("fast"),
        v.literal("index"),
        v.literal("scan"),
        v.literal("none"),
        v.literal("failed"),
      ),
      /** Percent of the quality searches that name an index. */
      share: v.number(),
      found: v.number(),
      first: v.number(),
      p50: v.number(),
    }),
  ),
  /** Workspaces with the most misses, lowest found first. */
  misses: v.array(
    v.object({
      workspaceId: v.id("workspaces"),
      slug: v.union(v.string(), v.null()),
      n: v.number(),
      found: v.number(),
      why: v.union(v.literal("index failed"), v.literal("meaning off by owner"), v.null()),
    }),
  ),
});

export type SearchQuality = Infer<typeof searchQualityValidator>;
type Figures = SearchQuality["all"];

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

function ofKey(rows: Row[], key: Key): Row[] {
  return rows.filter((row) => row.who !== undefined && (key === "all" || row.who === key));
}

function sortedMs(rows: Row[]): number[] {
  return rows.map((row) => row.ms).sort((a, b) => a - b);
}

export function figuresOf(rows: Row[], prior: Row[]): Figures {
  const n = rows.length;
  const opened = rows.filter((row) => row.opened !== undefined).length;
  const at = (place: number) => rows.filter((row) => row.opened === place).length;
  const fourOrFive = rows.filter((row) => row.opened === 4 || row.opened === 5).length;
  const sixOrLater = rows.filter((row) => row.opened !== undefined && row.opened >= 6).length;
  const again = rows.filter((row) => row.again === true).length;
  const gaveUp = rows.filter((row) => row.opened === undefined && row.again !== true).length;
  const times = sortedMs(rows);
  return {
    n,
    found: pct(opened, n),
    pos: [pct(at(1), n), pct(at(2), n), pct(at(3), n), pct(fourOrFive, n), pct(sixOrLater, n)],
    next: [pct(again, n), pct(gaveUp, n)],
    ms: [percentile(times, 50), percentile(times, 95)],
    foundBefore: pct(prior.filter((row) => row.opened !== undefined).length, prior.length),
  };
}

type Bucket = SearchQuality["series"][number]["all"];

function bucketOf(rows: Row[]): Bucket {
  const found = rows.filter((row) => row.opened !== undefined);
  const times = sortedMs(rows);
  return {
    found: pct(found.length, rows.length),
    first: pct(found.filter((row) => row.opened === 1).length, found.length),
    p50: percentile(times, 50),
    p95: percentile(times, 95),
  };
}

/** The series: the same buckets the tab's other charts use, so the axes line up. */
function series(rows: Row[], days: number, now: number): SearchQuality["series"] {
  const hourly = days === 1;
  const step = hourly ? HOUR_MS : DAY_MS;
  const count = hourly ? 24 : days;
  const firstStart = Math.floor(now / step) * step - (count - 1) * step;
  const grouped: Row[][] = Array.from({ length: count }, () => []);
  for (const row of rows) {
    const index = Math.floor((row.at - firstStart) / step);
    if (index >= 0 && index < count) grouped[index].push(row);
  }
  return grouped.map((bucketRows, index) => {
    const start = firstStart + index * step;
    const label = hourly ? `${new Date(start).toISOString().slice(11, 13)}:00` : dayKey(start);
    return {
      label,
      all: bucketOf(ofKey(bucketRows, "all")),
      app: bucketOf(ofKey(bucketRows, "app")),
      ai: bucketOf(ofKey(bucketRows, "ai")),
      tex: bucketOf(ofKey(bucketRows, "tex")),
    };
  });
}

function byIndexOf(rows: Row[]): SearchQuality["byIndex"] {
  const named = rows.filter((row) => row.answeredBy !== undefined);
  return ANSWERED_BY.flatMap((answeredBy) => {
    const group = named.filter((row) => row.answeredBy === answeredBy);
    if (group.length === 0) return [];
    const found = group.filter((row) => row.opened !== undefined);
    return [
      {
        answeredBy,
        share: pct(group.length, named.length),
        found: pct(found.length, group.length),
        first: pct(found.filter((row) => row.opened === 1).length, found.length),
        p50: percentile(sortedMs(group), 50),
      },
    ];
  });
}

/** Why a workspace misses, from the index state the Indexes view already reads. An owner's choice comes first. */
async function whyMisses(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<SearchQuality["misses"][number]["why"]> {
  const meaning = await meaningRowFor(ctx, workspaceId);
  if (meaning?.optedOut === true) return "meaning off by owner";
  const fast = await ctx.db
    .query("searchIndexes")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (meaning?.status === "failed" || fast?.status === "failed") return "index failed";
  return null;
}

async function missesOf(ctx: QueryCtx, rows: Row[]): Promise<SearchQuality["misses"]> {
  const byWorkspace = new Map<Id<"workspaces">, Row[]>();
  for (const row of rows) {
    const group = byWorkspace.get(row.workspaceId) ?? [];
    group.push(row);
    byWorkspace.set(row.workspaceId, group);
  }
  const counted = [...byWorkspace.entries()]
    .filter(([, group]) => group.length >= MIN_QUALITY_SEARCHES)
    .map(([workspaceId, group]) => ({
      workspaceId,
      n: group.length,
      found: pct(group.filter((row) => row.opened !== undefined).length, group.length),
    }))
    .sort((a, b) => a.found - b.found || b.n - a.n)
    .slice(0, MISSES_SHOWN);
  return await Promise.all(
    counted.map(async (entry) => ({
      ...entry,
      slug: (await ctx.db.get(entry.workspaceId))?.slug ?? null,
      why: await whyMisses(ctx, entry.workspaceId),
    })),
  );
}

/**
 * The quality figures for one window. `current` and `prior` are the screen and
 * AI rows `searchReport` already read for this window and the one before it,
 * already narrowed to the workspace asked for.
 */
export async function qualityHandler(
  ctx: QueryCtx,
  args: { days: number; now: number; current: Row[]; prior: Row[] },
): Promise<SearchQuality> {
  const current = args.current.filter((row) => row.who !== undefined);
  const prior = args.prior.filter((row) => row.who !== undefined);
  const figures = Object.fromEntries(
    KEYS.map((key) => [key, figuresOf(ofKey(current, key), ofKey(prior, key))]),
  ) as Record<Key, Figures>;
  return {
    ...figures,
    series: series(current, args.days, args.now),
    byIndex: byIndexOf(current),
    misses: await missesOf(ctx, current),
  };
}
