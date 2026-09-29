import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The newest devlog week each person has opened, so What's new stops showing
 * its dot on every device once it has been read anywhere.
 *
 * A number and a time about the reader, never the week's words: the words
 * are the pinned workspace's published `website/devlog.md`, and the app reads
 * them from there (`docs/decisions/release-communication.md`). One row per
 * person, deleted with the account (`personalRows.ts`).
 */
export const devlogTables = {
  devlogReads: defineTable({
    userId: v.id("users"),
    week: v.number(),
    seenAt: v.number(),
  }).index("by_user", ["userId"]),
};
