/**
 * THE SEARCH TAB'S FIGURES: how long searches take, where, and which index
 * answered, read from `searchTimings` (`functions/searchTimings.ts`).
 *
 * Asked for by the owner, 2026-10-07 ("make sure that we are able to track
 * the average search latency"). Staff only: `functions/admin.ts` calls
 * `requireAdmin` before this.
 *
 * Three views of the same searches, never added together, because one search
 * in the app writes two rows (the device's and the control plane's):
 *
 *  - `screen`: what a person waited in the app.
 *  - `app`: the app's searches measured in the control plane, the palette
 *    and the search page together.
 *  - `ai`: AI clients, measured in the gateway.
 *
 * "Average" is the mean, "typical" the median and "slowest 1 in 20" the 95th
 * percentile, by nearest rank. Each read is capped at `MAX_ROWS_READ`, newest
 * first, and says `truncated` past it. Reads stop at `now`, so a search that
 * lands while the tab is open does not re-run this query.
 */

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { dayKey } from "../usage";
import { percentile } from "./agentReport";

export const SEARCH_REPORT_WINDOWS = [1, 7, 30] as const;
export const SEARCH_VIEWS = ["screen", "app", "ai"] as const;
export type SearchView = (typeof SEARCH_VIEWS)[number];
// Four surfaces, two windows each: 16,000 rows at most, inside a query's read limit.
export const MAX_ROWS_READ = 2_000;
export const SLOWEST_SHOWN = 20;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The surfaces each view is read from. */
const VIEW_SURFACES: Record<SearchView, Doc<"searchTimings">["surface"][]> = {
  screen: ["screen"],
  app: ["app", "page"],
  ai: ["ai"],
};

const ANSWERED_BY = ["fast", "index", "scan", "none", "failed"] as const;

export function clampSearchDays(days: unknown): number {
  if (typeof days !== "number" || !Number.isFinite(days)) return 7;
  return SEARCH_REPORT_WINDOWS.reduce((best, w) => (Math.abs(w - days) < Math.abs(best - days) ? w : best), 7);
}

export function isSearchView(value: unknown): value is SearchView {
  return typeof value === "string" && (SEARCH_VIEWS as readonly string[]).includes(value);
}

/** Count, mean, median and 95th percentile of a list of times. */
export function summarize(values: readonly number[]): { count: number; avg: number; p50: number; p95: number } {
  if (values.length === 0) return { count: 0, avg: 0, p50: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, ms) => sum + ms, 0);
  return {
    count: sorted.length,
    avg: Math.round(total / sorted.length),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}

const stats = { count: v.number(), avg: v.number(), p50: v.number(), p95: v.number() };
const viewValidator = v.union(v.literal("screen"), v.literal("app"), v.literal("ai"));
const answeredByValidator = v.union(
  v.literal("fast"),
  v.literal("index"),
  v.literal("scan"),
  v.literal("none"),
  v.literal("failed"),
);

export const searchReportValidator = v.object({
  days: v.number(),
  view: viewValidator,
  /** The slug asked for, when it named a workspace that exists. */
  workspace: v.union(v.string(), v.null()),
  /** Some window held more rows than were read; the figures cover the newest. */
  truncated: v.boolean(),
  /** Every view's figures this window, and the window before, for the tiles. */
  views: v.array(v.object({ view: viewValidator, ...stats, workspaces: v.number(), prior: v.object(stats) })),
  /** The chosen view, hourly for a one-day window and daily otherwise; oldest first, zero-filled. */
  buckets: v.array(v.object({ label: v.string(), ...stats })),
  /** The chosen view by which index answered. Empty for `screen`, which cannot know. */
  answeredBy: v.array(v.object({ answeredBy: answeredByValidator, ...stats, misses: v.number() })),
  /** Searches that found something against searches that found nothing. */
  found: v.object({ hits: v.object(stats), misses: v.object(stats) }),
  slowest: v.array(
    v.object({
      id: v.string(),
      at: v.number(),
      workspace: v.union(v.string(), v.null()),
      surface: v.union(v.literal("screen"), v.literal("app"), v.literal("page"), v.literal("ai")),
      answeredBy: v.union(answeredByValidator, v.null()),
      found: v.boolean(),
      ms: v.number(),
    }),
  ),
});

export type SearchReport = Infer<typeof searchReportValidator>;

async function rowsBetween(
  ctx: QueryCtx,
  surface: Doc<"searchTimings">["surface"],
  from: number,
  to: number,
  workspaceId: Id<"workspaces"> | null,
): Promise<{ rows: Doc<"searchTimings">[]; truncated: boolean }> {
  const query =
    workspaceId === null
      ? ctx.db
          .query("searchTimings")
          .withIndex("by_surface_at", (q) => q.eq("surface", surface).gt("at", from).lte("at", to))
      : ctx.db
          .query("searchTimings")
          .withIndex("by_workspace_surface_at", (q) =>
            q.eq("workspaceId", workspaceId).eq("surface", surface).gt("at", from).lte("at", to),
          );
  const rows = await query.order("desc").take(MAX_ROWS_READ + 1);
  return { rows: rows.slice(0, MAX_ROWS_READ), truncated: rows.length > MAX_ROWS_READ };
}

async function viewRows(
  ctx: QueryCtx,
  view: SearchView,
  from: number,
  to: number,
  workspaceId: Id<"workspaces"> | null,
): Promise<{ rows: Doc<"searchTimings">[]; truncated: boolean }> {
  const reads = await Promise.all(VIEW_SURFACES[view].map((surface) => rowsBetween(ctx, surface, from, to, workspaceId)));
  return { rows: reads.flatMap((read) => read.rows), truncated: reads.some((read) => read.truncated) };
}

export async function searchReportHandler(
  ctx: QueryCtx,
  args: { days?: number; view?: string; workspace?: string },
  now: number = Date.now(),
): Promise<SearchReport> {
  const days = clampSearchDays(args.days);
  const view: SearchView = isSearchView(args.view) ? args.view : "screen";
  const slug = typeof args.workspace === "string" ? args.workspace.trim().replace(/^@/, "").toLowerCase() : "";
  const named =
    slug === "" ? null : await ctx.db.query("workspaces").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
  // A slug that names nothing matches no searches, rather than every search.
  const nothing = slug !== "" && named === null;
  const workspaceId = named?._id ?? null;
  const windowMs = days * DAY_MS;

  let truncated = false;
  const views: SearchReport["views"] = [];
  let chosen: Doc<"searchTimings">[] = [];
  for (const each of SEARCH_VIEWS) {
    const current = nothing ? { rows: [], truncated: false } : await viewRows(ctx, each, now - windowMs, now, workspaceId);
    const prior = nothing
      ? { rows: [], truncated: false }
      : await viewRows(ctx, each, now - 2 * windowMs, now - windowMs, workspaceId);
    truncated = truncated || current.truncated || prior.truncated;
    views.push({
      view: each,
      ...summarize(current.rows.map((row) => row.ms)),
      workspaces: new Set(current.rows.map((row) => row.workspaceId)).size,
      prior: summarize(prior.rows.map((row) => row.ms)),
    });
    if (each === view) chosen = current.rows;
  }

  // Buckets: hours for one day, days otherwise.
  const hourly = days === 1;
  const step = hourly ? HOUR_MS : DAY_MS;
  const count = hourly ? 24 : days;
  const bucketStart = Math.floor(now / step) * step;
  const bucketMs: number[][] = Array.from({ length: count }, () => []);
  for (const row of chosen) {
    const index = count - 1 - Math.floor((bucketStart - Math.floor(row.at / step) * step) / step);
    if (index >= 0 && index < count) bucketMs[index].push(row.ms);
  }
  const buckets = bucketMs.map((values, index) => {
    const start = bucketStart - (count - 1 - index) * step;
    const label = hourly ? `${new Date(start).toISOString().slice(11, 13)}:00` : dayKey(start);
    return { label, ...summarize(values) };
  });

  const answeredBy = ANSWERED_BY.flatMap((by) => {
    const rows = chosen.filter((row) => row.answeredBy === by);
    if (rows.length === 0) return [];
    return [{ answeredBy: by, ...summarize(rows.map((row) => row.ms)), misses: rows.filter((row) => !row.found).length }];
  });

  const slowestRows = [...chosen].sort((a, b) => b.ms - a.ms || b.at - a.at).slice(0, SLOWEST_SHOWN);
  const slugs = new Map<string, string | null>();
  for (const row of slowestRows) {
    if (!slugs.has(row.workspaceId)) slugs.set(row.workspaceId, (await ctx.db.get(row.workspaceId))?.slug ?? null);
  }

  return {
    days,
    view,
    workspace: named === null ? null : named.slug,
    truncated,
    views,
    buckets,
    answeredBy,
    found: {
      hits: summarize(chosen.filter((row) => row.found).map((row) => row.ms)),
      misses: summarize(chosen.filter((row) => !row.found).map((row) => row.ms)),
    },
    slowest: slowestRows.map((row) => ({
      id: row._id,
      at: row.at,
      workspace: slugs.get(row.workspaceId) ?? null,
      surface: row.surface,
      answeredBy: row.answeredBy ?? null,
      found: row.found,
      ms: row.ms,
    })),
  };
}
