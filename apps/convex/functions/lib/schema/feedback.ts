import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * One row per feedback report a person sent (or is sending), so a retry is
 * recognised and the daily limit is counted here rather than trusted to the
 * app.
 *
 * Ids, a state, times and which way it came in — **never the report**. The message, the screen, the
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
    /**
     * Which way it came in (`feedbackChannel`): the app's bug button, a text to
     * Tex, Tex in a group chat, another AI's `report_problem`, or a report about
     * content. One word, so the Context usage source can list user-reported
     * bugs by id (`usagePeople.exportRows`). Absent on receipts made before it.
     */
    channel: v.optional(
      v.union(v.literal("app"), v.literal("tex"), v.literal("tex-group"), v.literal("agent"), v.literal("content")),
    ),
  })
    .index("by_user_client", ["userId", "clientReportId"])
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_createdAt", ["createdAt"]),
};
