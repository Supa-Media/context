/**
 * THE SEARCH TIMING LOG: how long each search took and which index answered.
 *
 * Asked for by the owner, 2026-10-07 ("make sure that we are able to track
 * the average search latency"), after a look at why search feels slow found
 * nothing that measured it: the gateway logged a trace line nobody aggregated
 * and the console's search logged nothing at all. Every surface now writes a
 * row here and the admin console's Search tab reads them
 * (`lib/adminFns/searchReport.ts`).
 *
 * Four surfaces, because "how long did search take" has more than one honest
 * answer:
 *
 *  - `screen`: what a person waited in the app, from asking to the answer
 *    arriving on their device. Measured there, because only the device sees
 *    the network and the queueing in front of the server.
 *  - `app` and `page`: the same searches measured in the control plane, so
 *    the gap between the two is the network and nothing else.
 *  - `ai`: an AI client's search, measured in the gateway (Tex's too, with
 *    `who: "tex"`).
 *
 * THE QUALITY LOG rides on the same rows: a search's quality row carries `who`
 * and an opaque `actor`, the first result opened is `opened`, and the same
 * searcher searching again at once is `again`. Every quality number is worked
 * out from those, never from a query (`lib/adminFns/searchQuality.ts`).
 *
 * Never text. A row is a workspace, a surface, which index answered, whether
 * anything came back, a number of milliseconds, and hashes; the validators pin
 * that shape, and there is no field a query could be put in.
 */

import { getAuthUserId } from "./lib/signedIn";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { searchAnsweredByValidator, searchSurfaceValidator, searchWhoValidator } from "./lib/schema/searchTimings";
import { clampSearchMs } from "./lib/searchTiming";
import { actorFor, isActorId, isHitId, validHits } from "./lib/searchTimingIds";
import { getMembership } from "./lib/workspaceAuth";

/** How long a row is kept. Long enough to compare weeks, no longer. */
export const SEARCH_TIMING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** A search's hits are kept this long: long enough for the fetch that follows it, no longer. */
export const SEARCH_HITS_RETENTION_MS = 15 * 60 * 1000;
/** "Searched again" means within this long of the earlier search. */
export const AGAIN_WINDOW_MS = 60 * 1000;
/** An open of a search's results counts only this long after the search. */
export const OPEN_WINDOW_MS = 10 * 60 * 1000;
/** Positions a search's results can be opened at; anything past it is one bucket. */
export const MAX_OPEN_POSITION = 50;

/** The sweep runs hourly; it looks at this much before the hits' cut-off, so no row is missed. */
const HITS_SWEEP_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const MAX_OPEN_CANDIDATES = 50;

/** One searcher's recent quality searches, in any workspace, newest first. */
async function recentQualityRows(ctx: MutationCtx, actor: string, since: number) {
  return await ctx.db
    .query("searchTimings")
    .withIndex("by_actor_at", (q) => q.eq("actor", actor).gte("at", since))
    .order("desc")
    .take(MAX_OPEN_CANDIDATES);
}

/** A position from a client, held to 1..50. A non-number is the first place. */
export function clampOpenPosition(position: number): number {
  if (!Number.isFinite(position)) return 1;
  return Math.min(MAX_OPEN_POSITION, Math.max(1, Math.round(position)));
}

/**
 * Insert one row. A quality row first looks for the same searcher's search in
 * the minute before: if that one is still unopened and not yet re-searched, it
 * is marked `again`. Only the latest quality row is considered, as the rule is
 * "searched again", not "searched again at some point".
 */
async function insertTiming(ctx: MutationCtx, row: Omit<Doc<"searchTimings">, "_id" | "_creationTime">): Promise<void> {
  if (row.who !== undefined && row.actor !== undefined) {
    const earlier = await ctx.db
      .query("searchTimings")
      .withIndex("by_actor_at", (q) =>
        q.eq("actor", row.actor!).gte("at", row.at - AGAIN_WINDOW_MS).lte("at", row.at),
      )
      .order("desc")
      .take(MAX_OPEN_CANDIDATES);
    const latest = earlier.find((candidate) => candidate.who !== undefined);
    if (latest !== undefined && latest.opened === undefined && latest.again === undefined) {
      await ctx.db.patch(latest._id, { again: true });
    }
  }
  await ctx.db.insert("searchTimings", row);
}

/**
 * Mark the first result opened for one searcher. Only quality rows from the
 * last 10 minutes that nothing has opened yet are candidates, so a second open
 * of the same search, or an open after the window, changes nothing.
 *
 * - With `hit` (a gateway search): the newest candidate whose results held it
 *   is opened at that hit's place in the results (1-based).
 * - With `position` (the app): the newest candidate is opened at that place.
 *
 * Never throws on a bad match: a fetch that cannot be matched is just not counted.
 */
export async function markOpenedIn(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; actor: string; position?: number; hit?: string },
): Promise<void> {
  if (!isActorId(args.actor)) return;
  // The posted workspace is not part of the match: a hit is hashed with its own result's workspace.
  const candidates = (await recentQualityRows(ctx, args.actor, Date.now() - OPEN_WINDOW_MS)).filter(
    (row) => row.who !== undefined && row.opened === undefined,
  );
  if (args.hit !== undefined) {
    if (!isHitId(args.hit)) return;
    for (const row of candidates.filter((candidate) => candidate.who !== "app")) {
      const place = row.hits?.indexOf(args.hit) ?? -1;
      if (place >= 0) {
        await ctx.db.patch(row._id, { opened: place + 1 });
        return;
      }
    }
    return;
  }
  // A position comes only from the app, about the search it ran in this workspace: never a gateway row.
  const appRow = candidates.find((row) => row.who === "app" && row.workspaceId === args.workspaceId);
  if (args.position !== undefined && appRow !== undefined) {
    await ctx.db.patch(appRow._id, { opened: clampOpenPosition(args.position) });
  }
}

/** A row from the control plane or the gateway, which measured it themselves. */
export const record = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    surface: searchSurfaceValidator,
    answeredBy: searchAnsweredByValidator,
    found: v.boolean(),
    ms: v.number(),
    who: v.optional(searchWhoValidator),
    actor: v.optional(v.string()),
    hits: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // A workspace that has gone since the search started has nobody to report to.
    if ((await ctx.db.get(args.workspaceId)) === null) return null;
    // A quality row needs an actor it can be opened by, so a `who` without one is timing only.
    const quality = args.who !== undefined && isActorId(args.actor);
    const hits = validHits(args.hits);
    await insertTiming(ctx, {
      workspaceId: args.workspaceId,
      surface: args.surface,
      answeredBy: args.answeredBy,
      found: args.found,
      ms: clampSearchMs(args.ms),
      at: Date.now(),
      ...(quality ? { who: args.who, actor: args.actor } : {}),
      ...(hits === undefined ? {} : { hits }),
    });
    return null;
  },
});

/**
 * What a person waited in the app, reported by their device after the answer
 * landed. It is also the app's quality row: `who: "app"`, the actor is the
 * user's, derived here so the app never sends one.
 *
 * Only a member of the workspace may report for it, and a refusal answers
 * `false` rather than throwing: this runs behind a search that already
 * worked, and nothing about a timing is worth an error on somebody's screen.
 * The number is the device's own, so it is clamped rather than trusted; the
 * worst a member can do is make their own workspace look slow to staff.
 */
export const reportScreen = mutation({
  args: { workspaceId: v.id("workspaces"), ms: v.number(), found: v.boolean() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return false;
    if ((await getMembership(ctx, args.workspaceId, userId)) === null) return false;
    await insertTiming(ctx, {
      workspaceId: args.workspaceId,
      surface: "screen",
      found: args.found,
      ms: clampSearchMs(args.ms),
      at: Date.now(),
      who: "app",
      actor: await actorFor(userId),
    });
    return true;
  },
});

/**
 * The app's tap on a result: the 1-based place of the first result a person
 * opened in a search (the app sends it once per search). The same membership
 * rule as `reportScreen`, and `false` on refusal rather than an error.
 */
export const reportOpen = mutation({
  args: { workspaceId: v.id("workspaces"), position: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return false;
    if ((await getMembership(ctx, args.workspaceId, userId)) === null) return false;
    await markOpenedIn(ctx, {
      workspaceId: args.workspaceId,
      actor: await actorFor(userId),
      position: clampOpenPosition(args.position),
    });
    return true;
  },
});

/**
 * A gateway client's open of a note's content: the gateway calls this with
 * the hit's hash, behind the response (`lib/gatewayRoutes/searchOpen.ts`).
 */
export const markOpened = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actor: v.string(),
    position: v.optional(v.number()),
    hit: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await markOpenedIn(ctx, args);
    return null;
  },
});

/**
 * Drop rows past their retention, a batch at a time (crons.ts), and clear the
 * hits of quality rows past 15 minutes.
 *
 * The hits sweep looks at the two hours before the cut-off, not the whole log:
 * the sweep runs hourly, so each row falls in one run's window. A run that
 * never happens leaves its hits for the next run, which still reaches them
 * while they are inside that window.
 */
export const purgeOldSearchTimings = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const old = await ctx.db
      .query("searchTimings")
      .withIndex("by_at", (q) => q.lt("at", now - SEARCH_TIMING_RETENTION_MS))
      .take(1000);
    for (const row of old) await ctx.db.delete(row._id);

    const hitCutoff = now - SEARCH_HITS_RETENTION_MS;
    const due = await ctx.db
      .query("searchTimings")
      .withIndex("by_at", (q) => q.gt("at", hitCutoff - HITS_SWEEP_LOOKBACK_MS).lte("at", hitCutoff))
      .take(2000);
    for (const row of due) {
      if (row.hits !== undefined) await ctx.db.patch(row._id, { hits: undefined });
    }
    return null;
  },
});
