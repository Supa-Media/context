/**
 * Settings › Meetings, Joining from the calendar, kept on the account
 * (docs/decisions/meetings/joining-from-the-calendar.md).
 *
 * Both functions name no user: the caller is the only key, so a read or a
 * write can reach nobody else's row. The calendar read honours
 * `calendarsOff` (`meetingCalendar.claimMeetingCalendars`), and the console
 * hands `askBeforeMs` to the Mac app with the day's meetings.
 */

import { v } from "convex/values";
import { getAuthUserId, requireAuthId } from "./lib/signedIn";
import type { Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { consumeRateLimit } from "./lib/rateLimit";

const askBefore = v.union(v.literal(60_000), v.literal(300_000), v.null());

/** Generous for somebody flicking switches, small for a client stuck in a loop. */
const WRITES_PER_HOUR = 60;
const MEETING_PREFERENCES_WINDOW_MS = 60 * 60 * 1000;
/** As many as a workspace can connect (`meetingCalendar.ts` reads at most 20). */
const MAX_CALENDARS_OFF = 20;
const MAX_ADDRESS = 320;

/** The caller's choice, or null (signed out, or never chosen: every calendar, a minute before). */
export const myMeetingPreferences = query({
  args: {},
  returns: v.union(v.object({ calendarsOff: v.array(v.string()), askBeforeMs: askBefore, updatedAt: v.number() }), v.null()),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    const row = await ctx.db
      .query("meetingJoinPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row === null) return null;
    return { calendarsOff: row.calendarsOff, askBeforeMs: row.askBeforeMs, updatedAt: row.updatedAt };
  },
});

/** Replace the caller's choice. Addresses are kept lowercased and deduplicated. */
export const setMyMeetingPreferences = mutation({
  args: { calendarsOff: v.array(v.string()), askBeforeMs: askBefore },
  returns: v.number(),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await consumeRateLimit(ctx, {
      key: `meeting.preferences:${userId}`,
      limit: WRITES_PER_HOUR,
      windowMs: MEETING_PREFERENCES_WINDOW_MS,
    });
    const calendarsOff = [
      ...new Set(args.calendarsOff.map((address) => address.trim().toLowerCase()).filter((address) => address !== "" && address.length <= MAX_ADDRESS)),
    ].slice(0, MAX_CALENDARS_OFF);
    const updatedAt = Date.now();
    const row = await ctx.db
      .query("meetingJoinPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row === null) {
      await ctx.db.insert("meetingJoinPreferences", { userId, calendarsOff, askBeforeMs: args.askBeforeMs, updatedAt });
    } else {
      await ctx.db.patch(row._id, { calendarsOff, askBeforeMs: args.askBeforeMs, updatedAt });
    }
    return updatedAt;
  },
});
