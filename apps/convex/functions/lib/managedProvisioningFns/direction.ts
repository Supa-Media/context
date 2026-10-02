/**
 * Which way a `managedStorageMigrations` row moves a workspace's files.
 *
 * Three directions share one engine (see `docs/design/own-storage-moves`):
 *
 *  - `to_managed`: the owner's storage into a bucket Context runs. Rows
 *    written before `direction` existed are all this one, so absent means it.
 *  - `to_customer`: out of the bucket Context runs, into one the owner holds.
 *  - `to_own`: from storage the owner holds (a bucket, or Dropbox) into
 *    another bucket they hold. Context's storage is on neither end.
 *
 * Code used to ask `direction === "to_customer"` for two different questions,
 * and with a third direction those questions have different answers. So each
 * question has its own name here, and the engine asks the question it means.
 */

import { ConvexError } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";

export type MoveDirection = "to_managed" | "to_customer" | "to_own";

/** The row's direction, reading an absent one as the original `to_managed`. */
export function directionOf(row: { direction?: MoveDirection }): MoveDirection {
  return row.direction ?? "to_managed";
}

/**
 * The destination is a bucket the owner holds. Its files are theirs: it is
 * checked for existing files before the first write, and only Context's own
 * plumbing may ever be deleted from it without their typed consent.
 */
export function intoOwnersBucket(row: { direction?: MoveDirection }): boolean {
  const direction = directionOf(row);
  return direction === "to_customer" || direction === "to_own";
}

/** The source is the bucket Context runs, read through its encryption. */
export function outOfManagedBucket(row: { direction?: MoveDirection }): boolean {
  return directionOf(row) === "to_customer";
}

/**
 * The move touches Context's storage, so the plan row's provisioning state is
 * the console's view of it. A `to_own` move has nothing to do with the plan,
 * and a free workspace may have no plan row at all, so it never writes there.
 */
export function involvesManagedStorage(row: { direction?: MoveDirection }): boolean {
  return directionOf(row) !== "to_own";
}

/**
 * Refuse a change to a workspace's storage while a move of any direction is
 * copying. The move reads the binding it started from, and one changed under
 * it pauses with `SOURCE_CHANGED`; refusing here says why, before anything is
 * changed, instead of after.
 */
export async function refuseDuringMove(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<void> {
  const row = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (row?.status === "copying") {
    throw new ConvexError({
      code: "MOVE_IN_PROGRESS",
      message: "This workspace's files are being moved. Stop the move first.",
    });
  }
}
