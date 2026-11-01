import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Row and access changes waiting to reach a workspace's object (`lib/rowWatch/`, `workspaceObjectPush.ts`).
 *
 * Written only for a workspace whose notes are judged in its object, in the same transaction as the write it
 * names, and deleted once the object has taken it. Ids only, never a path or a note's words: the push reads each
 * row as it stands when it runs, so an entry replayed late cannot roll a row back.
 */
export const workspaceObjectOutboxTables = {
  workspaceObjectOutbox: defineTable({
    workspaceId: v.id("workspaces"),
    /** `nodes` rows written: pushed as they now stand, or removed if gone. */
    nodeIds: v.array(v.id("nodes")),
    /** The access rules may have changed: render them and send them. */
    access: v.boolean(),
    /** More rows changed than an entry names: push the workspace's rows whole. */
    all: v.optional(v.boolean()),
    at: v.number(),
  }).index("by_workspace_at", ["workspaceId", "at"]),

  /** The one drain carrying a workspace's outbox at a time, so its pushes leave in the order they were read. */
  workspaceObjectPushLeases: defineTable({
    workspaceId: v.id("workspaces"),
    until: v.number(),
  }).index("by_workspace", ["workspaceId"]),
};
