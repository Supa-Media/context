import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Settings › Meetings, Joining from the calendar (board j1-j3, 2026-10-27):
 * which connected calendars offer Join, and how long before a meeting the
 * Mac app asks. One row per person, so the choice holds on every device.
 *
 * Addresses and a number, never an event. A missing row means every
 * calendar, asked a minute before. Deleted with the account (`personalRows.ts`).
 */
export const meetingJoinTables = {
  meetingJoinPreferences: defineTable({
    userId: v.id("users"),
    /** Calendar addresses the person switched off, lowercased. */
    calendarsOff: v.array(v.string()),
    /** One minute or five before a meeting, or `null` for don't ask. */
    askBeforeMs: v.union(v.literal(60_000), v.literal(300_000), v.null()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
};
