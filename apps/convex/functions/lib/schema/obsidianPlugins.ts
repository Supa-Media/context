import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Obsidian plugin grants, managed bundle lifecycles, and the sandbox runtime's
 * short-lived bookkeeping.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts` in declaration order. Metadata only — see that
 * file's header.
 */
export const obsidianPluginTables = {
  /**
   * Explicit authority for one reviewed Obsidian plugin bundle.
   *
   * The bundle remains in the customer's bucket and never enters Convex. The
   * fingerprint binds this row to the manifest/main.js objects the scanner
   * reviewed, so syncing an update cannot inherit the old version's grant.
   */
  obsidianPluginGrants: defineTable({
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
    bundleFingerprint: v.string(),
    capabilities: v.array(
      v.union(
        v.literal("vault:read"),
        v.literal("metadata:read"),
        v.literal("vault:write"),
        v.literal("vault:rename"),
        v.literal("vault:delete"),
        v.literal("settings:read"),
        v.literal("settings:write"),
        v.literal("network:request"),
      ),
    ),
    /** Exact hosts approved from the scanner's evidence; no wildcards. */
    networkHosts: v.array(v.string()),
    status: v.union(v.literal("active"), v.literal("revoked")),
    grantedBy: v.id("users"),
    grantedAt: v.number(),
    updatedAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_plugin", ["workspaceId", "pluginId"]),

  /** Serializes managed bundle changes against review, grants, and runtime issuance. */
  obsidianPluginLifecycles: defineTable({
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
    generation: v.number(),
    busy: v.boolean(),
    operation: v.union(
      v.literal("installing"),
      v.literal("uninstalling"),
      v.literal("recovering"),
    ),
    updatedAt: v.number(),
  }).index("by_workspace_plugin", ["workspaceId", "pluginId"]),

  /** Short-lived, hashed bearer bindings held by the trusted sandbox host. */
  obsidianPluginRuntimeSessions: defineTable({
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
    bundleFingerprint: v.string(),
    tokenHash: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_workspace_plugin", ["workspaceId", "pluginId"]),

  /** At-most-once request ids for side-effecting sandbox RPC calls. */
  obsidianPluginRuntimeRequests: defineTable({
    tokenHash: v.string(),
    requestId: v.string(),
    operation: v.string(),
    claimedAt: v.number(),
  }).index("by_session_request", ["tokenHash", "requestId"]),

  /** Ephemeral execution health, never plugin output or note content. */
  obsidianPluginRuntimeStates: defineTable({
    workspaceId: v.id("workspaces"),
    pluginId: v.string(),
    bundleFingerprint: v.string(),
    status: v.union(
      v.literal("loaded"),
      v.literal("crash-looped"),
      v.literal("blocked"),
    ),
    attempts: v.number(),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    rollbackFingerprint: v.optional(v.string()),
    reportedBy: v.id("users"),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_plugin", ["workspaceId", "pluginId"]),
};
