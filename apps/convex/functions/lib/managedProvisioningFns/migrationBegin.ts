/**
 * The handlers for `managedProvisioning.beginManagedStorageMigration` and
 * `resumeManagedStorageMigration`.
 *
 * Split out of `functions/managedProvisioning.ts` — see that file's header
 * comment on `provisionManagedStorage` for the whole flow this belongs to.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { requireWorkspaceRole } from "../workspaceAuth";
import { R2_CREDENTIAL_SETTLE_MS } from "../cloudflare";
import { managedBucketName } from "../managedStorage";

type CustomerTarget = {
  provider: "r2" | "s3" | "b2" | "s3-compatible";
  endpoint: string;
  region: string;
  bucket: string;
  rootPrefix?: string;
  accessKeyId: string;
  encryptedSecretAccessKey: string;
  forcePathStyle?: boolean;
};

/** Park the managed destination without changing which storage is live. */
export async function beginManagedStorageMigrationHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    actorUserId: Id<"users">;
    sourceBindingId: Id<"storageBindings">;
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    encryptedSecretAccessKey: string;
  },
): Promise<null> {
  await requireWorkspaceRole(
    ctx,
    args.workspaceId,
    args.actorUserId,
    "owner",
  );
  const current = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (current?._id !== args.sourceBindingId) return null;

  const now = Date.now();
  const existing = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  const fields = {
    workspaceId: args.workspaceId,
    sourceBindingId: args.sourceBindingId,
    direction: "to_managed" as const,
    targetProvider: "r2" as const,
    targetEndpoint: args.endpoint,
    targetRegion: "auto",
    targetBucket: args.bucket,
    targetAccessKeyId: args.accessKeyId,
    encryptedTargetSecretAccessKey: args.encryptedSecretAccessKey,
    status: "copying" as const,
    phase: "count" as const,
    cursor: undefined,
    objectsCopied: 0,
    objectsTotal: undefined,
    objectsProcessedInPhase: 0,
    changesInPass: 0,
    readyToCutover: false,
    errorCode: undefined,
    startedBy: args.actorUserId,
    updatedAt: now,
  };
  if (existing === null) {
    await ctx.db.insert("managedStorageMigrations", {
      ...fields,
      createdAt: now,
    });
  } else if (existing.sourceBindingId === args.sourceBindingId) {
    // A retry resumes the destination it already created. Do not reset the
    // cursor or replace the credential with a second minted token.
    await ctx.db.patch(existing._id, {
      status: "copying",
      errorCode: undefined,
      readyToCutover: false,
      updatedAt: now,
    });
  }
  /*
    The copy is not started here, and that is the fix this indirection
    exists for. The bucket and the key it needs were minted seconds ago and
    are not usable at R2's S3 endpoint the instant Cloudflare's API returns
    — so the first thing that happens is a wait for the target to answer,
    exactly as `completeManagedProvisioning` waits for the BYO path's
    scheduled verification. Starting the walk in this tick is what made an
    upgrade report a failed copy that a retry then completed untouched.
  */
  await ctx.scheduler.runAfter(
    0,
    internal.functions.managedProvisioning.awaitManagedTargetReady,
    {
      workspaceId: args.workspaceId,
      retryUntil: now + R2_CREDENTIAL_SETTLE_MS,
    },
  );
  return null;
}

/** Two spellings of one endpoint: a trailing slash names the same host. */
function sameEndpoint(left: string, right: string): boolean {
  const bare = (endpoint: string) => endpoint.trim().replace(/\/+$/, "").toLowerCase();
  return bare(left) === bare(right);
}

/**
 * Park a customer-owned destination while the managed binding remains live.
 *
 * This deliberately shares the same migration row and worker as the paid move
 * in the other direction: both are raw-object reconciliation followed by one
 * atomic binding swap. The direction changes only the target binding written
 * at cutover and the cleanup owed afterwards.
 */
export async function beginManagedStorageHandoffHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    actorUserId: Id<"users">;
    target: CustomerTarget;
  },
): Promise<{ started: true }> {
  await requireWorkspaceRole(ctx, args.workspaceId, args.actorUserId, "owner");
  const current = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  const plan = await ctx.db
    .query("workspacePlans")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (
    current === null ||
    current.bucket !== managedBucketName(args.workspaceId) ||
    current.accessKeyId === undefined ||
    plan?.managedStorage !== true
  ) {
    throw new ConvexError({
      code: "NOT_MANAGED_STORAGE",
      message: "This context is not using Context-managed storage.",
    });
  }

  const now = Date.now();
  const existing = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  // A retry into the very destination an earlier attempt already checked was
  // empty keeps that answer: what is there now is this move's own partial
  // copy, and the move carries on from it. Any other destination is asked
  // again, because its contents belong to whoever put them there.
  const sameTarget =
    existing !== null &&
    existing.direction === "to_customer" &&
    sameEndpoint(existing.targetEndpoint, args.target.endpoint) &&
    existing.targetBucket === args.target.bucket &&
    (existing.targetRootPrefix ?? "") === (args.target.rootPrefix ?? "");
  const sameClaimedTarget = sameTarget && existing?.targetClaimed === true;
  const fields = {
    workspaceId: args.workspaceId,
    sourceBindingId: current._id,
    direction: "to_customer" as const,
    targetClaimed: sameClaimedTarget,
    // The owner's answer about files already there, like the claim, belongs
    // to one destination only.
    existingFiles: sameTarget ? existing?.existingFiles : undefined,
    failedKeys: undefined,
    targetProvider: args.target.provider,
    targetEndpoint: args.target.endpoint,
    targetRegion: args.target.region,
    targetBucket: args.target.bucket,
    targetRootPrefix: args.target.rootPrefix,
    targetAccessKeyId: args.target.accessKeyId,
    encryptedTargetSecretAccessKey: args.target.encryptedSecretAccessKey,
    targetForcePathStyle: args.target.forcePathStyle,
    status: "copying" as const,
    phase: "count" as const,
    cursor: undefined,
    objectsCopied: 0,
    objectsTotal: undefined,
    objectsProcessedInPhase: 0,
    changesInPass: 0,
    readyToCutover: false,
    errorCode: undefined,
    startedBy: args.actorUserId,
    updatedAt: now,
  };
  if (existing === null) {
    await ctx.db.insert("managedStorageMigrations", { ...fields, createdAt: now });
  } else {
    // Re-entering the destination is the retry. Start a fresh census because
    // the customer may have corrected the bucket or credential.
    await ctx.db.patch(existing._id, fields);
  }

  await ctx.db.patch(plan._id, {
    managedProvisioning: "running",
    managedProvisioningError: undefined,
    managedProvisioningAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(
    0,
    internal.functions.managedProvisioning.awaitManagedTargetReady,
    {
      workspaceId: args.workspaceId,
      retryUntil: now + R2_CREDENTIAL_SETTLE_MS,
    },
  );
  return { started: true };
}

/** Resume the parked destination; a newly connected source restarts its scan. */
export async function resumeManagedStorageMigrationHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; actorUserId: Id<"users"> },
): Promise<boolean> {
  const row = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (row === null) return false;
  const current = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (current === null) return false;
  const sourceChanged = current._id !== row.sourceBindingId;
  await ctx.db.patch(row._id, {
    sourceBindingId: current._id,
    startedBy: args.actorUserId,
    status: "copying",
    errorCode: undefined,
    failedKeys: undefined,
    readyToCutover: false,
    ...(sourceChanged
      ? {
          phase: "count" as const,
          cursor: undefined,
          objectsCopied: 0,
          objectsTotal: undefined,
          objectsProcessedInPhase: 0,
          changesInPass: 0,
        }
      : {}),
    updatedAt: Date.now(),
  });
  return true;
}
