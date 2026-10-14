/**
 * Light, Dark or follow the device, kept on the account.
 *
 * The app keeps a copy on each device so the choice paints before the first
 * frame and before sign-in; this is the copy that makes it follow the person.
 * Both functions name no user: the caller is the only key, so a read or write
 * can reach nobody else's row.
 */

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuthId } from "@supa-media/convex/auth";
import type { Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { consumeRateLimit } from "./lib/rateLimit";

const appearance = v.union(v.literal("system"), v.literal("light"), v.literal("dark"));

/**
 * Generous for a person tapping a toggle back and forth, small for a client
 * stuck in a loop writing the same row.
 */
const WRITES_PER_HOUR = 60;
const APPEARANCE_WINDOW_MS = 60 * 60 * 1000;

/** The caller's choice, or null (signed out, or never chosen). */
export const myAppearance = query({
  args: {},
  returns: v.union(v.object({ appearance, updatedAt: v.number() }), v.null()),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    const row = await ctx.db
      .query("appearancePreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row === null) return null;
    return { appearance: row.appearance, updatedAt: row.updatedAt };
  },
});

/** Replace the caller's choice. Returns when the account took it. */
export const setMyAppearance = mutation({
  args: { appearance },
  returns: v.number(),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await consumeRateLimit(ctx, {
      key: `appearance:${userId}`,
      limit: WRITES_PER_HOUR,
      windowMs: APPEARANCE_WINDOW_MS,
    });
    const updatedAt = Date.now();
    const row = await ctx.db
      .query("appearancePreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row === null) {
      await ctx.db.insert("appearancePreferences", { userId, appearance: args.appearance, updatedAt });
    } else {
      await ctx.db.patch(row._id, { appearance: args.appearance, updatedAt });
    }
    return updatedAt;
  },
});
