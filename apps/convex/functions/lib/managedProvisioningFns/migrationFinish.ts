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
import { managedBucketBound } from "../managedEncryptionFns/rollout";
import type { StorageCapabilities } from "../storage/shapes";
import {
  CATCH_UP_CLOCK_MARGIN_MS,
  CATCH_UP_PASS_DELAYS_MS,
  MANAGED_RETENTION_AFTER_HANDOFF_MS,
} from "./constants";

/** Atomically replace only the exact source binding the copy began from. */
export async function finishManagedStorageMigrationHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    /** What the move's own probe of the destination found, just before this. */
    capabilities?: StorageCapabilities;
  },
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
      if (migration.direction === "to_customer") {
        await ctx.scheduler.runAfter(0, internal.functions.handoffEmail.sendHandoffEmail, {
          workspaceId: args.workspaceId,
          recipientUserId: migration.startedBy,
          kind: "paused",
        });
      }
    }
    return { cutover: false };
  }

  const cutoverAt = Date.now();
  const applied = await ctx.runMutation(internal.functions.storage.applyBinding, {
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
  if (args.capabilities !== undefined) {
    // Connected now, not after the verification `applyBinding` queued. The
    // move has just listed, written, read back and probed this bucket, and in
    // the seconds a binding reads `unverified` the email worker refuses mail
    // for good and the gateway answers 503. The queued verification still
    // runs and has the last word.
    await ctx.db.patch(applied.bindingId, {
      status: "connected",
      capabilities: args.capabilities,
      lastVerifiedAt: cutoverAt,
    });
  }
  await ctx.db.delete(migration._id);
  // Moving out keeps the encryption row: the managed bucket is kept for a
  // week with its sealed files, and a switch back re-adopts it. Moving in
  // (back) re-walks whatever the bucket now holds in a mode that reads both.
  if (!toCustomer) await managedBucketBound(ctx, args.workspaceId);
  const retainedUntil = Date.now() + MANAGED_RETENTION_AFTER_HANDOFF_MS;
  if (plan !== null && toCustomer) {
    await ctx.db.patch(plan._id, {
      managedStorage: false,
      freeManaged: false,
      managedRetainedUntil: retainedUntil,
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
    // Not now: the owner gets a week to switch back, and the action checks
    // again at the time whether the workspace has returned to this bucket.
    await ctx.scheduler.runAt(
      retainedUntil,
      internal.functions.managedProvisioning.deleteManagedStorageAfterHandoff,
      {
        workspaceId: args.workspaceId,
        retainedUntil,
        bucket: current.bucket!,
        tokenId: current.accessKeyId,
      },
    );
  }
  // The old bucket's key, still sealed, for the passes that bring across what
  // landed there after the last check (`lib/moveCatchUp.ts`). Only an S3-family
  // key pair: a Dropbox grant is revoked by the rebind above.
  if (
    current.provider !== "dropbox" &&
    current.accessKeyId !== undefined &&
    current.encryptedSecretAccessKey !== undefined &&
    current.endpoint !== undefined &&
    current.bucket !== undefined
  ) {
    await ctx.scheduler.runAt(
      cutoverAt + CATCH_UP_PASS_DELAYS_MS[0],
      internal.functions.moveCatchUp.runMoveCatchUp,
      {
        workspaceId: args.workspaceId,
        targetBindingId: applied.bindingId,
        since: (migration.passStartedAt ?? migration.createdAt) - CATCH_UP_CLOCK_MARGIN_MS,
        cutoverAt,
        direction: toCustomer ? "to_customer" : "to_managed",
        pass: 0,
        source: {
          provider: current.provider,
          endpoint: current.endpoint,
          region: current.region ?? "auto",
          bucket: current.bucket,
          rootPrefix: current.rootPrefix,
          accessKeyId: current.accessKeyId,
          encryptedSecretAccessKey: current.encryptedSecretAccessKey,
          forcePathStyle: current.forcePathStyle,
        },
      },
    );
  }
  if (toCustomer) {
    await ctx.scheduler.runAfter(0, internal.functions.handoffEmail.sendHandoffEmail, {
      workspaceId: args.workspaceId,
      recipientUserId: migration.startedBy,
      kind: "finished",
      retainedUntil,
    });
  }
  return { cutover: true };
}
