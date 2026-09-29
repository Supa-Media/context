/**
 * What's new: which devlog week the caller has already read.
 *
 * The week itself comes from the pinned workspace's published site
 * (`websites.siteSnapshot`); this file only remembers the reader's place, so
 * the dot in the account menu clears on every device at once.
 */

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuthId } from "@supa-media/convex/auth";
import type { Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";

/** Far above any week the devlog will reach; refuses nonsense, not history. */
const MAX_WEEK = 10_000;

/** The newest week the caller has opened, or null (never, or signed out). */
export const devlogSeenWeek = query({
  args: {},
  returns: v.union(v.number(), v.null()),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    const row = await ctx.db
      .query("devlogReads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return row?.week ?? null;
  },
});

/**
 * Record that the caller opened `week`. Never moves backwards: an old tab
 * that opens an older copy cannot bring the dot back for a newer week.
 */
export const markDevlogSeen = mutation({
  args: { week: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    if (!Number.isInteger(args.week) || args.week < 1 || args.week > MAX_WEEK) return null;
    const row = await ctx.db
      .query("devlogReads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row === null) {
      await ctx.db.insert("devlogReads", { userId, week: args.week, seenAt: Date.now() });
    } else if (args.week > row.week) {
      await ctx.db.patch(row._id, { week: args.week, seenAt: Date.now() });
    }
    return null;
  },
});
