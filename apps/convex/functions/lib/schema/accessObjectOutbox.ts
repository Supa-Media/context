import { defineTable } from "convex/server";
import { v } from "convex/values";

/** An object table, as `lib/accessObjects/expected.ts` names it. */
export const objectTableValidator = v.union(
  v.literal("members"),
  v.literal("invites"),
  v.literal("reach"),
  v.literal("connections"),
  v.literal("sharedToMe"),
);

/**
 * Access changes waiting to reach an object while its workspace is on `dual` (`lib/accessHandOff/`,
 * `functions/accessObjectPush.ts`). Written in the same transaction as the change, deleted once the object took it.
 * Table names only, never a row, an address or a token hash: the push reads each table as Convex holds it when it
 * runs, so an entry replayed late cannot roll the object back.
 */
export const accessObjectOutboxTables = {
  accessObjectOutbox: defineTable({
    /** The object's own workspace: the workspace for members and invites, the person's personal one for the rest. */
    workspaceId: v.id("workspaces"),
    tables: v.array(objectTableValidator),
    at: v.number(),
  }).index("by_workspace_at", ["workspaceId", "at"]),

  /** The one push carrying a workspace's access outbox at a time, so its copies leave in the order they were read. */
  accessObjectPushLeases: defineTable({
    workspaceId: v.id("workspaces"),
    until: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * A deletion waiting for the objects to take it first (`functions/accessTakeAway.ts`): once an account's or a
   * workspace's access is decided in its objects, deleting it removes the members and revokes the connections there,
   * and only then deletes Convex's rows behind. Ids only.
   */
  accessTakeAways: defineTable({
    kind: v.union(v.literal("account"), v.literal("workspace")),
    userId: v.optional(v.id("users")),
    workspaceId: v.optional(v.id("workspaces")),
    at: v.number(),
    attempt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_workspace", ["workspaceId"]),
};
