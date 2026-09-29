import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * One row per feedback report a person sent (or is sending), so a retry is
 * recognised and the daily limit is counted here rather than trusted to the
 * app.
 *
 * Ids, a state and times — **never the report**. The message, the screen, the
 * activity log and the screenshot go to Sentry and nowhere else; this table
 * could not hold them if it wanted to. Swept after thirty days
 * (`purgeExpiredFeedbackReceipts`) and deleted with the account
 * (`personalRows.ts`).
 */
export const feedbackTables = {
  feedbackReceipts: defineTable({
    userId: v.id("users"),
    /** The app's id for the report: 96 random bits as hex. */
    clientReportId: v.string(),
    /** The Sentry event id the report is sent under, fixed at reservation. */
    eventId: v.string(),
    /** `sending` while a send is in flight; `sent` once Sentry took it. */
    state: v.union(v.literal("sending"), v.literal("sent")),
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
  })
    .index("by_user_client", ["userId", "clientReportId"])
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_createdAt", ["createdAt"]),
};
