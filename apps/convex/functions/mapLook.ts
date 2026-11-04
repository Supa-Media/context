/**
 * THE MAP'S LOOK — paper, pencil, names, motion and the rest of how the live
 * map is drawn, kept on the account so the choice follows the person across
 * phone, browser and desktop, as the appearance choice does.
 *
 *  1. **Only the caller's own row.** Neither function names a user, so nobody
 *     can read or set another person's look, and a signed-out caller gets
 *     nothing and sets nothing.
 *  2. **Only the look.** The validator names every field and its choices, and
 *     numbers are held to ranges, so the row cannot grow into anything else.
 *  3. **Bounded.** A loop in a client cannot churn the row without limit.
 *  4. **Leaves with the account.**
 */

import { v } from "convex/values";
import { getAuthUserId, requireAuthId } from "./lib/signedIn";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { mutation } from "./lib/rowWatch/mutations";
import { consumeRateLimit } from "./lib/rateLimit";
import { mapLookValidator } from "./lib/schema/mapLook";

/**
 * Generous for a person nudging a slider, small for a client stuck in a loop
 * writing the same row.
 */
const WRITES_PER_HOUR = 120;
const MAP_LOOK_WINDOW_MS = 60 * 60 * 1000;

/** Each number the look may hold, inclusive. Anything else is refused. */
const RANGES = {
  sketch: [0, 1],
  textSize: [8, 24],
  lineWidth: [0.2, 4],
  dotSize: [0.3, 3],
  spread: [0.4, 2.5],
} as const;

type Look = typeof mapLookValidator.type;

/** Refuse a number that is not finite or is outside its range. */
function checkRanges(look: Look): void {
  for (const field of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    const value = look[field];
    if (value === undefined) continue;
    const [low, high] = RANGES[field];
    if (!Number.isFinite(value) || value < low || value > high) {
      throw new Error(`${field} must be a number from ${low} to ${high}`);
    }
  }
}

/** The caller's look, or null (signed out, or never chosen). */
export const myMapLook = query({
  args: {},
  returns: v.union(v.object({ look: mapLookValidator, updatedAt: v.number() }), v.null()),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    const row = await ctx.db
      .query("mapLookPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row === null) return null;
    return { look: row.look, updatedAt: row.updatedAt };
  },
});

/** Replace the caller's whole look. Returns when the account took it. */
export const setMyMapLook = mutation({
  args: { look: mapLookValidator },
  returns: v.number(),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    checkRanges(args.look);
    await consumeRateLimit(ctx, {
      key: `mapLook:${userId}`,
      limit: WRITES_PER_HOUR,
      windowMs: MAP_LOOK_WINDOW_MS,
    });
    const updatedAt = Date.now();
    const row = await ctx.db
      .query("mapLookPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row === null) {
      await ctx.db.insert("mapLookPreferences", { userId, look: args.look, updatedAt });
    } else {
      await ctx.db.replace(row._id, { userId, look: args.look, updatedAt });
    }
    return updatedAt;
  },
});
