import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * A request to save or share one vault login, made by an agent and finished
 * by the person on a signed-in page (`functions/vault.ts`).
 *
 * Ids only. The login itself lives sealed in the workspace's bucket, and an
 * agent's suggested name or site travels on the link's URL, never here.
 */
export const vaultTables = {
  vaultRequests: defineTable({
    hashedToken: v.string(),
    workspaceId: v.id("workspaces"),
    /** The only person who may finish it: whoever's grant asked. */
    userId: v.id("users"),
    kind: v.union(v.literal("add"), v.literal("share")),
    /** For `share`: the entry, and the member it would be given to. */
    entryId: v.optional(v.string()),
    granteeUserId: v.optional(v.id("users")),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_hashed_token", ["hashedToken"])
    .index("by_expires", ["expiresAt"]),
};
