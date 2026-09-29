/**
 * The owner's answer when the bucket they are moving into already has files.
 *
 * Context sees the whole bucket, never a folder of it (owner, 2026-09-29), so
 * a destination with files in it gets one of two answers instead of being
 * refused outright: start fresh, which deletes what is there and needs the
 * bucket's name typed as consent, or merge, which keeps every file of theirs
 * and shows it in the workspace beside the notes that move in.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { R2_CREDENTIAL_SETTLE_MS } from "../cloudflare";

export async function chooseExistingFilesHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    choice: "replace" | "merge";
    confirmBucket?: string;
  },
): Promise<{ resumed: true }> {
  const row = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (
    row === null ||
    row.direction !== "to_customer" ||
    row.status !== "failed" ||
    row.errorCode !== "DESTINATION_NOT_EMPTY"
  ) {
    throw new ConvexError({
      code: "NOT_WAITING_FOR_CHOICE",
      message: "This move is not waiting for an answer about files already in the bucket.",
    });
  }
  // Deleting somebody's files needs them to say which bucket, in their words.
  if (args.choice === "replace" && (args.confirmBucket ?? "").trim() !== row.targetBucket) {
    throw new ConvexError({
      code: "CONFIRMATION_MISMATCH",
      message: "Type the bucket's name exactly to delete what is in it.",
    });
  }
  const now = Date.now();
  await ctx.db.patch(row._id, {
    existingFiles: args.choice,
    targetClaimed: false,
    status: "copying",
    phase: "count",
    cursor: undefined,
    objectsCopied: 0,
    objectsTotal: undefined,
    objectsProcessedInPhase: 0,
    changesInPass: 0,
    readyToCutover: false,
    errorCode: undefined,
    failedKeys: undefined,
    updatedAt: now,
  });
  const plan = await ctx.db
    .query("workspacePlans")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (plan !== null) {
    await ctx.db.patch(plan._id, {
      managedProvisioning: "running",
      managedProvisioningError: undefined,
      managedProvisioningAt: now,
      updatedAt: now,
    });
  }
  await ctx.scheduler.runAfter(
    0,
    internal.functions.managedProvisioning.awaitManagedTargetReady,
    { workspaceId: args.workspaceId, retryUntil: now + R2_CREDENTIAL_SETTLE_MS },
  );
  return { resumed: true };
}
