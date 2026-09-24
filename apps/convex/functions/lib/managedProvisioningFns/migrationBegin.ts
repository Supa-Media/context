/**
 * The handlers for `managedProvisioning.beginManagedStorageMigration` and
 * `resumeManagedStorageMigration`.
 *
 * Split out of `functions/managedProvisioning.ts` — see that file's header
 * comment on `provisionManagedStorage` for the whole flow this belongs to.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { requireWorkspaceRole } from "../workspaceAuth";
import { R2_CREDENTIAL_SETTLE_MS } from "../cloudflare";

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
    targetEndpoint: args.endpoint,
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
