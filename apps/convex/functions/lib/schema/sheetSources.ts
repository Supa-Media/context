import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * A sheet source: a key that may add rows to one sheet and do nothing else
 * (decided by the owner, 2026-11-24; see `functions/sheetSources.ts`).
 *
 * Only the key's SHA-256 is kept (`lib/crypto.ts` `hashToken`): it is shown
 * once, when it is made, and can be matched but never read back. A source
 * acts as the member who made it, narrowed to appending to `path`, so it stops
 * working when they leave the workspace or can no longer edit it.
 */
export const sheetSourceTables = {
  sheetSources: defineTable({
    workspaceId: v.id("workspaces"),
    /** The sheet it adds to, as the tree names it. */
    path: v.string(),
    /** What the sender is, in the owner's words ("GitHub speed budgets"): written beside each row's audit line. */
    name: v.string(),
    keyHash: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
    rowsAdded: v.number(),
  })
    .index("by_key_hash", ["keyHash"])
    .index("by_workspace_path", ["workspaceId", "path"]),
};
