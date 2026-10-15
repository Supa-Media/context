import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { managedBucketName } from "../managedStorage";

/**
 * Put a managed bucket on the erasure queue, inside the transaction that is
 * about to delete the row naming it.
 *
 * Called by the workspace cascade before it deletes the binding (and any
 * managed-storage move that holds a second managed credential). The row is
 * written in the same transaction as those deletions, so either both happen
 * or neither does: there is no moment at which the bucket exists and nothing
 * remembers it.
 *
 * Refuses, by doing nothing, a bucket that is not this workspace's managed
 * bucket. A customer's own bucket is never named this way, and the action
 * re-checks the name before it touches anything.
 *
 * Scheduled, not called: the erasure opens the operator credential, and this
 * runs inside a public mutation that must never reach a decrypt.
 */
export async function queueManagedErasure(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; bucket: string; tokenId?: string },
): Promise<Id<"managedErasures"> | null> {
  if (args.bucket !== managedBucketName(args.workspaceId)) return null;
  const existing = await ctx.db
    .query("managedErasures")
    .withIndex("by_bucket", (q) => q.eq("bucket", args.bucket))
    .collect();
  const same = existing.find((row) => row.tokenId === args.tokenId);
  if (same !== undefined) return same._id;
  const now = Date.now();
  const erasureId = await ctx.db.insert("managedErasures", {
    workspaceId: args.workspaceId,
    bucket: args.bucket,
    tokenId: args.tokenId,
    status: "pending",
    bucketDeleted: false,
    token: args.tokenId === undefined ? "absent" : "pending",
    objectsDeleted: 0,
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.functions.managedErasure.runManagedErasure, { erasureId });
  return erasureId;
}
