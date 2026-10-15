import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Who each person has blocked: one row per (blocker, blocked) pair.
 *
 * Per recipient, never global. A row narrows what reaches the **blocker** —
 * the blocked person's named shares leave their @shared list and stop
 * opening for them, and that person's invitations to them stop being listed,
 * accepted or mailed — and changes nothing for anybody else. It deletes no
 * content and removes nobody from a workspace. See
 * `docs/decisions/privacy-and-sharing/reporting-and-blocking.md`.
 *
 * Two ids and a time; the blocked person is never told, and nothing they can
 * read depends on this table. Deleted with either account
 * (`lib/account/personalRows.ts`, through `deleteBlocksOf`).
 */
export const blockTables = {
  userBlocks: defineTable({
    blockerId: v.id("users"),
    blockedId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_blocker", ["blockerId", "createdAt"])
    .index("by_blocker_blocked", ["blockerId", "blockedId"])
    .index("by_blocked", ["blockedId"]),
};
