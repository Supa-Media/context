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
  DROPBOX_REVOKE_BACKSTOP_MS,
  MANAGED_RETENTION_AFTER_HANDOFF_MS,
} from "./constants";
import { directionOf, intoOwnersBucket } from "./direction";

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
  const toOwn = migration?.direction === "to_own";
  if (
    migration === null ||
    migration.status !== "copying" ||
    migration.phase !== "verify_target" ||
    migration.readyToCutover !== true ||
    current?._id !== migration.sourceBindingId ||
    (toCustomer &&
      (current.bucket !== managedBucketName(args.workspaceId) ||
        current.accessKeyId === undefined ||
        plan?.managedStorage !== true)) ||
    // Between the owner's own buckets, Context's storage is on neither end.
    (toOwn && (current.bucket === managedBucketName(args.workspaceId) || plan?.managedStorage === true))
  ) {
    if (migration !== null) {
      await ctx.db.patch(migration._id, {
        status: "failed",
        errorCode: "SOURCE_CHANGED",
        updatedAt: Date.now(),
      });
      if (intoOwnersBucket(migration)) {
        await ctx.scheduler.runAfter(0, internal.functions.handoffEmail.sendHandoffEmail, {
          workspaceId: args.workspaceId,
          recipientUserId: migration.startedBy,
          kind: "paused",
          ...(migration.direction === "to_own" ? { ownMove: true } : {}),
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
    cutover: true,
    // The catch-up passes below still read Dropbox, and revoke it after.
    deferDropboxRevoke: current.provider === "dropbox",
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
  if (directionOf(migration) === "to_managed") await managedBucketBound(ctx, args.workspaceId);
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
  } else if (plan !== null && !toOwn) {
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
    action: toOwn
      ? "storage.moved"
      : toCustomer
        ? "storage.managed_handed_off"
        : "storage.managed_migrated",
    details: toOwn
      ? { objectsCopied: migration.objectsCopied, from: current.provider, to: migration.targetProvider ?? "r2" }
      : { objectsCopied: migration.objectsCopied },
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
  // landed there after the last check (`lib/moveCatchUp.ts`). A Dropbox source
  // sends its sealed refresh token instead: its grant was kept standing above
  // for exactly these passes, which revoke it when they end. The revoke after
  // the last pass would have run is the backstop for passes that never do.
  if (current.provider === "dropbox" && current.encryptedRefreshToken !== undefined) {
    await ctx.scheduler.runAt(
      cutoverAt + CATCH_UP_PASS_DELAYS_MS[0],
      internal.functions.moveCatchUp.runMoveCatchUp,
      {
        workspaceId: args.workspaceId,
        targetBindingId: applied.bindingId,
        since: (migration.passStartedAt ?? migration.createdAt) - CATCH_UP_CLOCK_MARGIN_MS,
        cutoverAt,
        direction: directionOf(migration),
        pass: 0,
        source: {
          provider: "dropbox" as const,
          rootPrefix: current.rootPrefix,
          encryptedRefreshToken: current.encryptedRefreshToken,
        },
      },
    );
    await ctx.scheduler.runAt(
      cutoverAt + DROPBOX_REVOKE_BACKSTOP_MS,
      internal.functions.dropboxConnect.revokeDropboxGrant,
      { workspaceId: args.workspaceId, encryptedRefreshToken: current.encryptedRefreshToken },
    );
  }
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
        direction: directionOf(migration),
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
