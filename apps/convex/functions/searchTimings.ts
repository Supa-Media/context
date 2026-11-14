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
 * THE QUALITY LOG rides on the same rows: a search's quality row carries `who`,
 * the first result opened is `opened`, and the same searcher searching again
 * at once is `again`. Every quality number is worked out from those, never
 * from a query (`lib/adminFns/searchQuality.ts`).
 *
 * PAIRING IS SHORT-LIVED. The app pairs its own search with its open by row id,
 * on the device (`features/console/files/searchOpenReport.ts`), so an app row
 * never holds an actor. A gateway search pairs with a later open or search by
 * an HMAC the gateway computed under a key Convex does not hold, and that
 * pairing data (`actor`, `hits`) lives only `SEARCH_PAIR_RETENTION_MS` past the
 * search: the sweep clears it, paging until nothing is left.
 *
 * Never text. A row is a workspace, a surface, which index answered, whether
 * anything came back, a number of milliseconds, and opaque ids; the validators
 * pin that shape, and there is no field a query could be put in.
 */

import { getAuthUserId } from "./lib/signedIn";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { searchAnsweredByValidator, searchSurfaceValidator, searchWhoValidator } from "./lib/schema/searchTimings";
import { clampSearchMs } from "./lib/searchTiming";
import { isActorId, isHitId, validHits } from "./lib/searchTimingIds";
import { getMembership } from "./lib/workspaceAuth";

/** How long a row is kept. Long enough to compare weeks, no longer. */
export const SEARCH_TIMING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Pairing data (`actor`, `hits`) lives this long after the search, and no longer. */
export const SEARCH_PAIR_RETENTION_MS = 15 * 60 * 1000;
/** "Searched again" means within this long of the earlier search. */
export const AGAIN_WINDOW_MS = 60 * 1000;
/** An open of a search's results counts only this long after the search. */
export const OPEN_WINDOW_MS = 10 * 60 * 1000;
/** Positions a search's results can be opened at; anything past it is one bucket. */
export const MAX_OPEN_POSITION = 50;

const MAX_OPEN_CANDIDATES = 50;
/** Rows per page of either sweep. A full page reschedules the sweep. */
const SWEEP_PAGE = 1000;

/** A position from a client, held to 1..50. A non-number is the first place. */
export function clampOpenPosition(position: number): number {
  if (!Number.isFinite(position)) return 1;
  return Math.min(MAX_OPEN_POSITION, Math.max(1, Math.round(position)));
}

/** A gateway row whose pairing data is still live at `now`. */
function paired(row: Doc<"searchTimings">, now: number): boolean {
  return row.pairUntil !== undefined && row.pairUntil > now;
}

/**
 * Insert one row and return its id. A gateway quality row first looks for the
 * same searcher's search in the minute before: if that one is still paired,
 * unopened and not yet re-searched, it is marked `again`. Only the latest
 * paired quality row is considered, as the rule is "searched again", not
 * "searched again at some point".
 */
async function insertTiming(
  ctx: MutationCtx,
  row: Omit<Doc<"searchTimings">, "_id" | "_creationTime">,
): Promise<Id<"searchTimings">> {
  if (row.who !== undefined && row.actor !== undefined) {
    const earlier = await ctx.db
      .query("searchTimings")
      .withIndex("by_actor_at", (q) =>
        q.eq("actor", row.actor!).gte("at", row.at - AGAIN_WINDOW_MS).lte("at", row.at),
      )
      .order("desc")
      .take(MAX_OPEN_CANDIDATES);
    const latest = earlier.find((candidate) => candidate.who !== undefined && paired(candidate, row.at));
    if (latest !== undefined && latest.opened === undefined && latest.again === undefined) {
      await ctx.db.patch(latest._id, { again: true });
    }
  }
  const pairs = row.actor !== undefined || row.hits !== undefined;
  return await ctx.db.insert("searchTimings", {
    ...row,
    ...(pairs ? { pairUntil: row.at + SEARCH_PAIR_RETENTION_MS } : {}),
  });
}

/**
 * Mark the first result opened, for a gateway search. The searcher's paired
 * quality rows from the last 10 minutes that nothing has opened yet are the
 * candidates. The newest whose results held the hit is opened at that hit's
 * place (1-based). A hit matches by hash alone, across workspaces: a note read
 * from another workspace is hashed by its `@name/path` address.
 *
 * Never throws on a bad match: a fetch that cannot be matched is just not counted.
 */
export async function markOpenedIn(ctx: MutationCtx, args: { actor: string; hit: string }): Promise<void> {
  if (!isActorId(args.actor) || !isHitId(args.hit)) return;
  const now = Date.now();
  const candidates = await ctx.db
    .query("searchTimings")
    .withIndex("by_actor_at", (q) => q.eq("actor", args.actor).gte("at", now - OPEN_WINDOW_MS))
    .order("desc")
    .take(MAX_OPEN_CANDIDATES);
  for (const row of candidates) {
    if (row.who === undefined || row.opened !== undefined || !paired(row, now)) continue;
    const place = row.hits?.indexOf(args.hit) ?? -1;
    if (place >= 0) {
      await ctx.db.patch(row._id, { opened: place + 1 });
      return;
    }
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

const screenResult = v.object({
  ok: v.boolean(),
  row: v.union(v.id("searchTimings"), v.null()),
});

/**
 * What a person waited in the app, reported by their device after the answer
 * landed. It is also the app's quality row: `who: "app"`, with no actor. The
 * device keeps the row's id and pairs its own open and re-search by that id
 * (`reportOpen`, `reportAgain`); nothing here identifies the user.
 *
 * Only a member of the workspace may report for it, and a refusal answers
 * `{ok: false, row: null}` rather than throwing: this runs behind a search that
 * already worked, and nothing about a timing is worth an error on somebody's
 * screen. The number is the device's own, so it is clamped rather than trusted.
 */
export const reportScreen = mutation({
  args: { workspaceId: v.id("workspaces"), ms: v.number(), found: v.boolean() },
  returns: screenResult,
  handler: async (ctx, args) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return { ok: false, row: null };
    if ((await getMembership(ctx, args.workspaceId, userId)) === null) return { ok: false, row: null };
    const row = await insertTiming(ctx, {
      workspaceId: args.workspaceId,
      surface: "screen",
      found: args.found,
      ms: clampSearchMs(args.ms),
      at: Date.now(),
      who: "app",
    });
    return { ok: true, row };
  },
});

/** The app's own rows, looked up by id and checked for the caller's membership of their workspace. */
async function appRowFor(ctx: MutationCtx, row: Id<"searchTimings">): Promise<Doc<"searchTimings"> | null> {
  const found = await ctx.db.get(row);
  if (found === null || found.who !== "app") return null;
  const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
  if (userId === null) return null;
  if ((await getMembership(ctx, found.workspaceId, userId)) === null) return null;
  return found;
}

/**
 * The app's tap on a result: the 1-based place of the first result a person
 * opened in the search that `row` names. Only the first open counts, and only
 * within 10 minutes of the search. A member of that row's workspace only;
 * `false` on refusal, never an error.
 */
export const reportOpen = mutation({
  args: { row: v.id("searchTimings"), position: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const found = await appRowFor(ctx, args.row);
    if (found === null || found.opened !== undefined) return false;
    if (Date.now() - found.at > OPEN_WINDOW_MS) return false;
    await ctx.db.patch(found._id, { opened: clampOpenPosition(args.position) });
    return true;
  },
});

/**
 * The app's search that `row` names was followed by another within 60 s with
 * nothing opened: the device calls this on the earlier row when the new search
 * starts, with `refined` when the new query only extends or trims the old one.
 * Same membership rule as `reportOpen`; `false` on refusal.
 */
export const reportAgain = mutation({
  args: { row: v.id("searchTimings"), refined: v.optional(v.boolean()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const found = await appRowFor(ctx, args.row);
    if (found === null || found.opened !== undefined || found.again !== undefined) return false;
    if (Date.now() - found.at > AGAIN_WINDOW_MS) return false;
    // `refined`: the next search only extended or trimmed this one's query (the device compares them; the query
    // never leaves it), so this was one search still being typed. It leaves the quality counts and keeps its timing.
    if (args.refined === true) await ctx.db.patch(found._id, { who: undefined, pairUntil: undefined });
    else await ctx.db.patch(found._id, { again: true });
    return true;
  },
});

/**
 * A gateway client's open of a note's content: the gateway calls this with
 * the hit's HMAC, behind the response (`lib/gatewayRoutes/searchOpen.ts`).
 */
export const markOpened = internalMutation({
  args: {
    actor: v.string(),
    hit: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await markOpenedIn(ctx, args);
    return null;
  },
});

/**
 * Drop rows past their retention, a batch at a time (crons.ts), and clear the
 * pairing data of every row whose `pairUntil` has passed.
 *
 * The pairing sweep pages through `by_pairUntil` from the oldest, and a full
 * page reschedules the sweep, so a backlog of any size empties in a chain of
 * short runs. Clearing a row takes it out of that index, so each page is new
 * rows, and the sweep ends when a page comes back short.
 */
export const purgeOldSearchTimings = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const now = Date.now();
    const old = await ctx.db
      .query("searchTimings")
      .withIndex("by_at", (q) => q.lt("at", now - SEARCH_TIMING_RETENTION_MS))
      .take(SWEEP_PAGE);
    for (const row of old) await ctx.db.delete(row._id);

    const lapsed = await ctx.db
      .query("searchTimings")
      // Bounded below: a row whose pairing is gone has no `pairUntil` at all, and must never be paged again.
      .withIndex("by_pairUntil", (q) => q.gt("pairUntil", 0).lt("pairUntil", now))
      .take(SWEEP_PAGE);
    for (const row of lapsed) {
      await ctx.db.patch(row._id, { actor: undefined, hits: undefined, pairUntil: undefined });
    }
    if (lapsed.length === SWEEP_PAGE) {
      await ctx.scheduler.runAfter(0, internal.functions.searchTimings.purgeOldSearchTimings, {});
    }
    return null;
  },
});

/**
 * One-time: rows written before `pairUntil` existed may hold `actor` and `hits`
 * with no expiry, and the pairing sweep above cannot see them. This walks the
 * whole table by cursor and clears that pairing data from every such row.
 * Run it once after the deploy that adds `pairUntil`; it reschedules itself
 * until the table is walked.
 */
export const scrubLegacyPairing = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query("searchTimings")
      .withIndex("by_at")
      .paginate({ cursor: args.cursor, numItems: SWEEP_PAGE });
    for (const row of page.page) {
      if (row.pairUntil === undefined && (row.actor !== undefined || row.hits !== undefined)) {
        await ctx.db.patch(row._id, { actor: undefined, hits: undefined });
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.functions.searchTimings.scrubLegacyPairing, { cursor: page.continueCursor });
    }
    return null;
  },
});
