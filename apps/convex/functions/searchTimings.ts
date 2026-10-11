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
 *  - `ai`: an AI client's search, measured in the gateway.
 *
 * Never text. A row is a workspace, a surface, which index answered, whether
 * anything came back and a number of milliseconds; the validators pin that
 * shape, and there is no field a query could be put in.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, mutation } from "../_generated/server";
import { searchAnsweredByValidator, searchSurfaceValidator } from "./lib/schema/searchTimings";
import { clampSearchMs } from "./lib/searchTiming";
import { getMembership } from "./lib/workspaceAuth";

/** How long a row is kept. Long enough to compare weeks, no longer. */
export const SEARCH_TIMING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** A row from the control plane or the gateway, which measured it themselves. */
export const record = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    surface: searchSurfaceValidator,
    answeredBy: searchAnsweredByValidator,
    found: v.boolean(),
    ms: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // A workspace that has gone since the search started has nobody to report to.
    if ((await ctx.db.get(args.workspaceId)) === null) return null;
    await ctx.db.insert("searchTimings", {
      workspaceId: args.workspaceId,
      surface: args.surface,
      answeredBy: args.answeredBy,
      found: args.found,
      ms: clampSearchMs(args.ms),
      at: Date.now(),
    });
    return null;
  },
});

/**
 * What a person waited in the app, reported by their device after the answer
 * landed.
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
    await ctx.db.insert("searchTimings", {
      workspaceId: args.workspaceId,
      surface: "screen",
      found: args.found,
      ms: clampSearchMs(args.ms),
      at: Date.now(),
    });
    return true;
  },
});

/** Drop rows past their retention, a batch at a time (crons.ts). */
export const purgeOldSearchTimings = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const old = await ctx.db
      .query("searchTimings")
      .withIndex("by_at", (q) => q.lt("at", Date.now() - SEARCH_TIMING_RETENTION_MS))
      .take(1000);
    for (const row of old) await ctx.db.delete(row._id);
    return null;
  },
});
