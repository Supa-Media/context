import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Reports people sent from the app (`functions/reports.ts`), kept so staff can
 * work them from the console's Reports tab and the Terms' 24-hour promise has
 * a queue behind it. Each is also mailed to the support address
 * (`functions/contentReports.ts`).
 *
 * What a report carries and nothing more: the kind, the reason, the
 * reporter's own words, and the ids the server resolved. Never a note's body,
 * title or path, never a share or invitation token. Deleted with the
 * reporter's account (`lib/account/personalRows.ts`).
 */
export const contentReportTables = {
  contentReports: defineTable({
    reporterId: v.id("users"),
    /** The feedback event id: one row per sent report, however often it is retried. */
    eventId: v.string(),
    kind: v.union(v.literal("share"), v.literal("invitation"), v.literal("workspace_note"), v.literal("public_page")),
    reason: v.string(),
    details: v.optional(v.string()),
    resolved: v.boolean(),
    ids: v.record(v.string(), v.string()),
    platform: v.string(),
    createdAt: v.number(),
    handledAt: v.optional(v.number()),
    handledBy: v.optional(v.id("users")),
  })
    .index("by_event", ["eventId"])
    .index("by_reporter", ["reporterId"])
    .index("by_handled", ["handledAt", "createdAt"]),
};
