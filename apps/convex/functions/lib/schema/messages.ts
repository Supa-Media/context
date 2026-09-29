import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * When each person answered each in-app message, so a message is answered
 * once per person rather than once per browser.
 *
 * `message` is a name from `IN_APP_MESSAGES` (`packages/shared`) and nothing
 * else; `workspaceId` is set for a message answered per workspace; `variant`
 * is a short label from that list's pattern (a role, never note text). A time
 * and those labels, nothing more. Deleted with the account
 * (`personalRows.ts`) and with the workspace (`finalizeWorkspaceDeletion.ts`).
 */
export const messageTables = {
  messageReads: defineTable({
    userId: v.id("users"),
    message: v.string(),
    workspaceId: v.optional(v.id("workspaces")),
    variant: v.optional(v.string()),
    seenAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_workspace", ["workspaceId"]),
};
