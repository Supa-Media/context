/**
 * The owner's controls on a move out of managed storage that is under way.
 *
 * Starting the move is `storage.startManagedStorageHandoff`, because it takes a
 * credential and lives beside the other functions that do. Stopping it takes
 * nothing but the workspace, and opens nothing.
 */

import { v } from "convex/values";
import { internalMutation, mutation } from "../_generated/server";
import { requireUserId } from "./lib/managedProvisioningFns/helpers";
import { requireWorkspaceRole } from "./lib/workspaceAuth";
import { cancelManagedStorageHandoffHandler } from "./lib/managedProvisioningFns/migrationFail";
import { recordAudit } from "./lib/audit";
import { chooseExistingFilesHandler } from "./lib/managedProvisioningFns/existingFiles";
import { beginOwnStorageMoveHandler } from "./lib/managedProvisioningFns/migrationBegin";

/** Stop the move. Owner-only; the managed bucket was never switched away from. */
export const cancelManagedStorageHandoff = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ cancelled: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");
    const result = await cancelManagedStorageHandoffHandler(ctx, args.workspaceId);
    if (result.cancelled) {
      await recordAudit(ctx, {
        workspaceId: args.workspaceId,
        actorUserId: userId,
        action: "storage.managed_handoff_cancelled",
        details: {},
      });
    }
    return result;
  },
});

/**
 * Answer for the files already in the destination: start fresh or merge.
 * Owner-only; starting fresh needs the bucket's name typed as consent.
 */
export const chooseExistingFilesForHandoff = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    choice: v.union(v.literal("replace"), v.literal("merge")),
    confirmBucket: v.optional(v.string()),
  },
  returns: v.object({ resumed: v.literal(true) }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");
    const result = await chooseExistingFilesHandler(ctx, args);
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "storage.managed_handoff_existing_files",
      details: { choice: args.choice },
    });
    return result;
  },
});

/**
 * Park the destination of a `to_own` move. Internal: `storage.startStorageMove`
 * checks and seals the destination and passes only the envelope here.
 */
export const beginOwnStorageMove = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    target: v.object({
      provider: v.union(
        v.literal("r2"),
        v.literal("s3"),
        v.literal("b2"),
        v.literal("s3-compatible"),
      ),
      endpoint: v.string(),
      region: v.string(),
      bucket: v.string(),
      rootPrefix: v.optional(v.string()),
      accessKeyId: v.string(),
      encryptedSecretAccessKey: v.string(),
      forcePathStyle: v.optional(v.boolean()),
    }),
  },
  returns: v.object({ started: v.literal(true) }),
  handler: async (ctx, args) => beginOwnStorageMoveHandler(ctx, args),
});
