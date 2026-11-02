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
    /** At `object`: members who joined and invitations that changed, put in the object row by row (`accessHandOff/adds.ts`). */
    adds: v.optional(v.object({ userIds: v.array(v.string()), inviteIds: v.array(v.string()) })),
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
    /**
     * `account` / `workspace`: a deletion. `leave`: `userId` leaves `workspaceIds` (a dropped sign-in domain). `fold`:
     * `userId`'s memberships in `workspaceIds` moved to `intoId` (one person's two accounts), already in Convex.
     */
    kind: v.union(v.literal("account"), v.literal("workspace"), v.literal("leave"), v.literal("fold"), v.literal("ungroup")),
    userId: v.optional(v.id("users")),
    /** `ungroup`: `userIds` leave `groupId` in `workspaceId`, or the whole group goes (`accessHandOff/ungroup.ts`). */
    groupId: v.optional(v.id("workspaceGroups")),
    userIds: v.optional(v.array(v.id("users"))),
    wholeGroup: v.optional(v.boolean()),
    workspaceId: v.optional(v.id("workspaces")),
    workspaceIds: v.optional(v.array(v.id("workspaces"))),
    intoId: v.optional(v.id("users")),
    at: v.number(),
    attempt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_into", ["intoId"])
    .index("by_workspace", ["workspaceId"]),
};
