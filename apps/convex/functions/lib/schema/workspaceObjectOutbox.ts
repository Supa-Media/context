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
    /** Object ids (`nodes.objectId`) of rows the object made that this change deleted outright: pushed as removed. */
    goneObjectIds: v.optional(v.array(v.string())),
    /** The access rules may have changed: render them and send them. */
    access: v.boolean(),
    /** More rows changed than an entry names: push the workspace's rows whole. */
    all: v.optional(v.boolean()),
    /** A change that may narrow, written with no mark open in the object (`lib/rowWatch/objectFirst.ts`): logged. */
    unmarked: v.optional(v.boolean()),
    /** The storage binding may have changed: clear the copy the object keeps (`workspaceObjectBinding.ts`). */
    binding: v.optional(v.boolean()),
    at: v.number(),
  }).index("by_workspace_at", ["workspaceId", "at"]),

  /**
   * "A change is coming", opened in the workspace's object before a write that may narrow commits here
   * (`lib/rowWatch/objectFirst.ts`, `apps/mcp/src/workspaceStore/marks.js`). `doneAt`: when the write committed, so
   * the first push that reads after it closes the mark with the rows that carry the change. A random token only.
   */
  workspaceObjectMarks: defineTable({
    workspaceId: v.id("workspaces"),
    token: v.string(),
    openedAt: v.number(),
    doneAt: v.optional(v.number()),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_token", ["token"]),

  /**
   * Writes that may narrow and opened no mark first, kept a week so each writer still to move can be found
   * (`functions/workspaceObjectMarks.ts` `report`). `source`: where the mutation was defined. No path, no words.
   */
  workspaceObjectUnmarked: defineTable({
    workspaceId: v.id("workspaces"),
    source: v.string(),
    rows: v.number(),
    access: v.boolean(),
    at: v.number(),
  }).index("by_at", ["at"]),

  /** The one drain carrying a workspace's outbox at a time, so its pushes leave in the order they were read. */
  workspaceObjectPushLeases: defineTable({
    workspaceId: v.id("workspaces"),
    until: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * Each workspace's last failed push: when, and a short code for why (an op and status such as `ws.apply: 422`, or
   * an error's class), so a push that keeps failing can be read from the marks report without the deployment's logs.
   * One row a workspace, deleted once a push lands. No path, no words.
   */
  workspaceObjectPushFailures: defineTable({
    workspaceId: v.id("workspaces"),
    reason: v.string(),
    at: v.number(),
    count: v.number(),
  }).index("by_workspace", ["workspaceId"]),
};
