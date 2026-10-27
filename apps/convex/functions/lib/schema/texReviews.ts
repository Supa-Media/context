import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Tex's self-review (`docs/decisions/texting-assistant/self-review.md`).
 *
 * When a texted conversation ends, a small model scores it. Who it was with
 * decides what is kept (`functions/texReviews.ts`), and none of it is here:
 * the words, when they are kept at all, are a note in the pinned context.
 */
export const texReviewTables = {
  /**
   * The person said yes to sharing their finished conversations with Tex, so
   * the team can read them to make Tex better (Settings → Feedback). A row is
   * the yes; no row is no, which is everyone's default. Deleted with the
   * account (`personalRows.ts`), and turning the switch off deletes it.
   */
  texReviewSharing: defineTable({
    userId: v.id("users"),
    sharedAt: v.number(),
  }).index("by_user", ["userId"]),

  /**
   * One finished conversation's scores, 1 to 10, higher is better, for
   * everyone who texts Tex. Numbers, a day and a reason word only: no person,
   * no workspace, no chat, never a word anybody said, so a row cannot be
   * traced back to who it was about. `day` is the UTC date, which the daily
   * scores note groups by.
   */
  texReviewScores: defineTable({
    day: v.string(),
    at: v.number(),
    kind: v.union(v.literal("one"), v.literal("group")),
    /** `ended`, `fix_this` or `frustrated`: what made the review run. */
    reason: v.string(),
    goal: v.number(),
    independence: v.number(),
    turns: v.number(),
    friendly: v.number(),
    calm: v.number(),
    /**
     * Codes and counts for the Tex dashboard (2026-10-24), still naming
     * nobody: what it was for (`TASK_CODES`), what showed frustration
     * (`SIGNAL_CODES`), how many texts it took, who in coarse terms (`staff`,
     * `new` for an account under a week old, else `other`), and what its last
     * turns cost and whether any ran on the thinking tier. Missing on rows
     * from before.
     */
    task: v.optional(v.string()),
    signals: v.optional(v.array(v.string())),
    texts: v.optional(v.number()),
    who: v.optional(v.union(v.literal("staff"), v.literal("new"), v.literal("other"))),
    costMicroUsd: v.optional(v.number()),
    thought: v.optional(v.boolean()),
  })
    .index("by_day", ["day"])
    .index("by_at", ["at"]),
};
