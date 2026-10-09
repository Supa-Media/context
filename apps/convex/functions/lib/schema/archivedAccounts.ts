import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Accounts staff archived in the console's People tab (Dev2, 2026-10-09):
 * test accounts cluttering the console. Archiving only hides an account from
 * the staff console's lists and figures. Nothing is deleted: the account,
 * its workspaces and their buckets stay exactly as they were, it can still
 * sign in, and Unarchive puts it back. Deleted with the account.
 */
export const archivedAccountTables = {
  archivedAccounts: defineTable({
    userId: v.id("users"),
    archivedBy: v.id("users"),
    archivedAt: v.number(),
  }).index("by_user", ["userId"]),
};
