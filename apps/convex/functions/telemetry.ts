/**
 * The Privacy & feedback switches, kept on the account.
 *
 * The app keeps a copy on each device so the choice applies before sign-in
 * and offline; this is the copy that makes a choice follow the person. Both
 * functions name no user: the caller is the only key, so a read or write can
 * reach nobody else's row.
 */

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuthId } from "@supa-media/convex/auth";
import type { Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { consumeRateLimit } from "./lib/rateLimit";

const preferences = v.object({
  crashReports: v.boolean(),
  screenCounts: v.boolean(),
  recordings: v.boolean(),
  updatedAt: v.number(),
});

/**
 * Generous for a person flipping switches, small for a client stuck in a
 * loop writing the same row.
 */
const WRITES_PER_HOUR = 60;
const PREFERENCES_WINDOW_MS = 60 * 60 * 1000;

/** The caller's switches, or null (signed out, or never chosen). */
export const myTelemetryPreferences = query({
  args: {},
  returns: v.union(preferences, v.null()),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    const row = await ctx.db
      .query("telemetryPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row === null) return null;
    return {
      crashReports: row.crashReports,
      screenCounts: row.screenCounts,
      recordings: row.recordings,
      updatedAt: row.updatedAt,
    };
  },
});

/**
 * Replace the caller's switches. All three every time, so a write is a whole
 * choice and two devices can never leave a row that is half of each.
 */
export const setMyTelemetryPreferences = mutation({
  args: { crashReports: v.boolean(), screenCounts: v.boolean(), recordings: v.boolean() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await consumeRateLimit(ctx, {
      key: `telemetry.preferences:${userId}`,
      limit: WRITES_PER_HOUR,
      windowMs: PREFERENCES_WINDOW_MS,
    });
    const updatedAt = Date.now();
    const choice = {
      crashReports: args.crashReports,
      screenCounts: args.screenCounts,
      recordings: args.recordings,
      updatedAt,
    };
    const row = await ctx.db
      .query("telemetryPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row === null) await ctx.db.insert("telemetryPreferences", { userId, ...choice });
    else await ctx.db.patch(row._id, choice);
    return updatedAt;
  },
});
