/**
 * The handlers for `managedProvisioning.beginManagedStorageMigration` and
 * `resumeManagedStorageMigration`.
 *
 * Split out of `functions/managedProvisioning.ts` — see that file's header
 * comment on `provisionManagedStorage` for the whole flow this belongs to.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { requireWorkspaceRole } from "../workspaceAuth";
import { R2_CREDENTIAL_SETTLE_MS } from "../cloudflare";
import { managedBucketName } from "../managedStorage";
import { directionOf, refuseDuringMove } from "./direction";

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
  } else if (directionOf(existing) !== "to_managed") {
    // A stopped move of another direction is replaced, never resumed: its
    // destination is a bucket the owner holds, not the one minted for this.
    await ctx.db.patch(existing._id, {
      ...fields,
      targetRootPrefix: undefined,
      targetForcePathStyle: undefined,
      targetClaimed: undefined,
      existingFiles: undefined,
      failedKeys: undefined,
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
  const fields = ownerTargetFields(existing, args.target, {
    direction: "to_customer",
    workspaceId: args.workspaceId,
    sourceBindingId: current._id,
    actorUserId: args.actorUserId,
    now,
  });
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

/**
 * A fresh census into a bucket the owner holds, shared by the move out of
 * managed storage and the `to_own` move so the two cannot drift.
 *
 * A retry into the very destination an earlier attempt already checked was
 * empty keeps that answer: what is there now is this move's own partial copy,
 * and the move carries on from it. Any other destination is asked again,
 * because its contents belong to whoever put them there.
 */
function ownerTargetFields(
  existing: Doc<"managedStorageMigrations"> | null,
  target: CustomerTarget,
  move: {
    direction: "to_customer" | "to_own";
    workspaceId: Id<"workspaces">;
    sourceBindingId: Id<"storageBindings">;
    actorUserId: Id<"users">;
    now: number;
  },
) {
  const sameTarget =
    existing !== null &&
    existing.direction === move.direction &&
    sameEndpoint(existing.targetEndpoint, target.endpoint) &&
    existing.targetBucket === target.bucket &&
    (existing.targetRootPrefix ?? "") === (target.rootPrefix ?? "");
  return {
    workspaceId: move.workspaceId,
    sourceBindingId: move.sourceBindingId,
    direction: move.direction,
    targetClaimed: sameTarget && existing?.targetClaimed === true,
    // The owner's answer about files already there, like the claim, belongs
    // to one destination only.
    existingFiles: sameTarget ? existing?.existingFiles : undefined,
    failedKeys: undefined,
    targetProvider: target.provider,
    targetEndpoint: target.endpoint,
    targetRegion: target.region,
    targetBucket: target.bucket,
    targetRootPrefix: target.rootPrefix,
    targetAccessKeyId: target.accessKeyId,
    encryptedTargetSecretAccessKey: target.encryptedSecretAccessKey,
    targetForcePathStyle: target.forcePathStyle,
    status: "copying" as const,
    phase: "count" as const,
    cursor: undefined,
    objectsCopied: 0,
    objectsTotal: undefined,
    objectsProcessedInPhase: 0,
    changesInPass: 0,
    readyToCutover: false,
    errorCode: undefined,
    startedBy: move.actorUserId,
    updatedAt: move.now,
  };
}

/**
 * Park a destination for a `to_own` move: from the storage the owner holds now
 * (a bucket, or Dropbox) into another bucket they hold.
 *
 * Context's storage is on neither end, so nothing here reads or writes the
 * plan row: a free workspace may not have one, and the console reads this
 * move's progress from the migration row itself. The old storage stays live
 * until the engine has copied and verified everything, and is never touched
 * afterwards either (`docs/design/own-storage-moves`).
 */
export async function beginOwnStorageMoveHandler(
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
  if (current === null) {
    throw new ConvexError({
      code: "NO_STORAGE",
      message: "This workspace has no storage connected to move from.",
    });
  }
  const plan = await ctx.db
    .query("workspacePlans")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (current.bucket === managedBucketName(args.workspaceId) || plan?.managedStorage === true) {
    throw new ConvexError({
      code: "MANAGED_STORAGE",
      message: "This workspace is on Context storage. Use the move out of Context storage instead.",
    });
  }
  if (
    current.provider !== "dropbox" &&
    current.endpoint !== undefined &&
    sameEndpoint(current.endpoint, args.target.endpoint) &&
    current.bucket === args.target.bucket &&
    (current.rootPrefix ?? "") === (args.target.rootPrefix ?? "")
  ) {
    throw new ConvexError({
      code: "SAME_STORAGE",
      message: "That is the bucket this workspace already uses.",
    });
  }
  await refuseDuringMove(ctx, args.workspaceId);

  const now = Date.now();
  const existing = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  const fields = ownerTargetFields(existing, args.target, {
    direction: "to_own",
    workspaceId: args.workspaceId,
    sourceBindingId: current._id,
    actorUserId: args.actorUserId,
    now,
  });
  if (existing === null) {
    await ctx.db.insert("managedStorageMigrations", { ...fields, createdAt: now });
  } else {
    // A stopped or failed move of any direction is replaced: the owner has
    // chosen this destination now.
    await ctx.db.patch(existing._id, fields);
  }
  await ctx.scheduler.runAfter(
    0,
    internal.functions.managedProvisioning.awaitManagedTargetReady,
    { workspaceId: args.workspaceId, retryUntil: now + R2_CREDENTIAL_SETTLE_MS },
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
