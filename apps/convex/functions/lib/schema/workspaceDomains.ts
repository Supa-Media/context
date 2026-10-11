import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * A shared workspace opened to everyone with an email at one domain (Dev2,
 * 2026-10-09, boards s3/s4): `publicworship.org`, say. Somebody with a
 * confirmed address there joins when they open a link to the workspace, with
 * `role`; nobody else learns it exists.
 *
 * An owner can add only a domain they sign in with themselves, and never a
 * personal mail service (`lib/emailDomains.ts`). `enabled` is the switch:
 * off stops new joins and leaves the people already in alone. Removing the
 * row does the same. Deleted with the workspace.
 */
export const workspaceDomainTables = {
  workspaceDomains: defineTable({
    workspaceId: v.id("workspaces"),
    /** Lower case, no `@`. */
    domain: v.string(),
    role: v.union(v.literal("editor"), v.literal("member")),
    enabled: v.boolean(),
    addedBy: v.id("users"),
    addedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_domain", ["domain"]),
};
