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
};
