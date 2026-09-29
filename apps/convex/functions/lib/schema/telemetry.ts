import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The Privacy & feedback switches, one row per person, so turning one off on
 * a phone holds in the browser too.
 *
 * Three booleans and a time, never anything the switches govern: no events,
 * no reports, no counts. A missing row means the person has not chosen, and
 * every client reads that as the documented default (everything on, as the
 * early-beta notice says). Deleted with the account (`personalRows.ts`).
 */
export const telemetryTables = {
  telemetryPreferences: defineTable({
    userId: v.id("users"),
    crashReports: v.boolean(),
    screenCounts: v.boolean(),
    recordings: v.boolean(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  /**
   * When each person pressed "Got it" on the early-beta notice, so it is
   * dismissed once per person rather than once per browser. A time and
   * nothing else; deleted with the account.
   */
  betaNoticeReads: defineTable({
    userId: v.id("users"),
    seenAt: v.number(),
  }).index("by_user", ["userId"]),
};
