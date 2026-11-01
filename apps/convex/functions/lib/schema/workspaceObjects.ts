import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Where each workspace's note bodies and rows are read from while they move
 * into its workspace object (decided by the owner, 2026-11-01;
 * `docs/decisions/storage-and-credentials/workspace-objects.md`). One row per
 * workspace that has started; no row means `bucket`. The object holds the
 * same switch (`ws.home`), set by the same flip (`functions/workspaceObjects.ts`
 * `setHome`), so the control plane knows it without a call.
 *
 * Counts, times and digests only: never a key, a path or a body.
 */
export const workspaceObjectTables = {
  workspaceObjectHomes: defineTable({
    workspaceId: v.id("workspaces"),
    home: v.union(v.literal("bucket"), v.literal("dual"), v.literal("object")),
    /** When `home` was last set. */
    since: v.number(),
    /** When every body and the rows were last copied whole. */
    backfilledAt: v.optional(v.number()),
    /** The rows digest last pushed to the object, and the rules' access version with it. */
    rowsSha: v.optional(v.string()),
    rulesVersion: v.optional(v.number()),
    rowsSyncedAt: v.optional(v.number()),
    /** The last parity check: zero everywhere is a match. */
    parity: v.optional(
      v.object({
        at: v.number(),
        bodies: v.object({
          bucketKeys: v.number(),
          objectKeys: v.number(),
          missingInObject: v.number(),
          extraInObject: v.number(),
          differ: v.number(),
        }),
        rows: v.object({ convex: v.number(), object: v.number(), match: v.boolean() }),
        rules: v.object({ match: v.boolean() }),
        visibility: v.object({ principals: v.number(), checked: v.number(), differ: v.number() }),
      }),
    ),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_home", ["home"]),
};
