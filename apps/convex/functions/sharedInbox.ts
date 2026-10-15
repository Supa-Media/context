/**
 * @shared: when the caller last looked at what was shared with them.
 *
 * The list itself is `shares.listSharedWithMe`; this file only remembers the
 * reader's place, so the dot beside @shared in the account menu clears on
 * every device at once — `devlog.ts`'s shape for What's new.
 */

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuthId } from "@supa-media/convex/auth";
import type { Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";

/** When the caller last opened @shared, or null (never, or signed out). */
export const sharedSeenAt = query({
  args: {},
  returns: v.union(v.number(), v.null()),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    const row = await ctx.db
      .query("sharedInboxReads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return row?.seenAt ?? null;
  },
});

/** Record that the caller has looked at @shared now. Time is the server's. */
export const markSharedSeen = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const now = Date.now();
    const row = await ctx.db
      .query("sharedInboxReads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row === null) await ctx.db.insert("sharedInboxReads", { userId, seenAt: now });
    else if (now > row.seenAt) await ctx.db.patch(row._id, { seenAt: now });
    return null;
  },
});
