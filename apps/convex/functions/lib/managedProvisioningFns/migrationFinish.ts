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
  if (
    migration === null ||
    migration.status !== "copying" ||
    migration.phase !== "verify_target" ||
    migration.readyToCutover !== true ||
    current?._id !== migration.sourceBindingId
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
    provider: "r2",
    endpoint: migration.targetEndpoint,
    region: "auto",
    bucket: migration.targetBucket,
    accessKeyId: migration.targetAccessKeyId,
    encryptedSecretAccessKey: migration.encryptedTargetSecretAccessKey,
  });
  await ctx.db.delete(migration._id);
  const plan = await ctx.db
    .query("workspacePlans")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (plan !== null) {
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
    action: "storage.managed_migrated",
    details: { objectsCopied: migration.objectsCopied },
  });
  return { cutover: true };
}
