import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * When each person last opened @shared, so its dot in the account menu clears
 * on every device once they have looked.
 *
 * A time about the reader and nothing else: which notes were shared is
 * `noteShares`, and this row never names one. One row per person, deleted with
 * the account (`personalRows.ts`).
 */
export const sharedInboxTables = {
  sharedInboxReads: defineTable({
    userId: v.id("users"),
    seenAt: v.number(),
  }).index("by_user", ["userId"]),
};
