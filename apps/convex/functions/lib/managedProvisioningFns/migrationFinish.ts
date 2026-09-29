/**
 * The handler for `managedProvisioning.finishManagedStorageMigration`.
 *
 * Split out of `functions/managedProvisioning.ts` — see that file's header
 * comment on `provisionManagedStorage` for the whole flow this belongs to.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { managedBucketName } from "../managedStorage";
import { enrollNewManagedWorkspace, forgetWorkspaceEncryption } from "../managedEncryptionFns/rollout";

/** Atomically replace only the exact source binding the copy began from. */
export async function finishManagedStorageMigrationHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<{ cutover: boolean }> {
  const migration = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  const current = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  const plan = await ctx.db
    .query("workspacePlans")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  const toCustomer = migration?.direction === "to_customer";
  if (
    migration === null ||
    migration.status !== "copying" ||
    migration.phase !== "verify_target" ||
    migration.readyToCutover !== true ||
    current?._id !== migration.sourceBindingId ||
    (toCustomer &&
      (current.bucket !== managedBucketName(args.workspaceId) ||
        current.accessKeyId === undefined ||
        plan?.managedStorage !== true))
  ) {
    if (migration !== null) {
      await ctx.db.patch(migration._id, {
        status: "failed",
        errorCode: "SOURCE_CHANGED",
        updatedAt: Date.now(),
      });
    }
    return { cutover: false };
  }

  await ctx.runMutation(internal.functions.storage.applyBinding, {
    workspaceId: args.workspaceId,
    actorUserId: migration.startedBy,
    provider: migration.targetProvider ?? "r2",
    endpoint: migration.targetEndpoint,
    region: migration.targetRegion ?? "auto",
    bucket: migration.targetBucket,
    rootPrefix: migration.targetRootPrefix,
    accessKeyId: migration.targetAccessKeyId,
    encryptedSecretAccessKey: migration.encryptedTargetSecretAccessKey,
    forcePathStyle: migration.targetForcePathStyle,
  });
  await ctx.db.delete(migration._id);
  // Their files are plain in their own bucket now. Nothing about the managed
  // bucket's encryption may follow them if they ever move back.
  if (toCustomer) await forgetWorkspaceEncryption(ctx, args.workspaceId);
  else await enrollNewManagedWorkspace(ctx, args.workspaceId);
  if (plan !== null && toCustomer) {
    await ctx.db.patch(plan._id, {
      managedStorage: false,
      freeManaged: false,
      managedProvisioning: undefined,
      managedProvisioningError: undefined,
      managedProvisioningAt: Date.now(),
      updatedAt: Date.now(),
    });
  } else if (plan !== null) {
    await ctx.db.patch(plan._id, {
      managedProvisioning: "ready",
      managedProvisioningError: undefined,
      managedProvisioningAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: migration.startedBy,
    action: toCustomer
      ? "storage.managed_handed_off"
      : "storage.managed_migrated",
    details: { objectsCopied: migration.objectsCopied },
  });
  if (toCustomer && current.accessKeyId !== undefined) {
    await ctx.scheduler.runAfter(
      0,
      internal.functions.managedProvisioning.deleteManagedStorageAfterHandoff,
      {
        workspaceId: args.workspaceId,
        bucket: current.bucket!,
        tokenId: current.accessKeyId,
      },
    );
  }
  return { cutover: true };
}
