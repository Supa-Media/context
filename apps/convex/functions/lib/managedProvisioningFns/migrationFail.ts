/**
 * Recording a stopped migration, and the handler for
 * `managedProvisioning.failManagedStorageMigration`.
 *
 * Split out of `functions/managedProvisioning.ts` — see that file's header
 * comment on `provisionManagedStorage` for the whole flow this belongs to.
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { handoffEmailKindFor } from "./handoffEmail";

/**
 * Stop a migration in both places a stopped migration has to be recorded.
 *
 * The row is what the copy resumes from; the plan is what the console reads.
 * Writing one without the other is how a migration ends up invisible — either
 * a screen reporting progress on a walk that stopped, or a failure the owner is
 * shown with a copy still running behind it.
 */
export async function failMigrationRowAndPlan(
  ctx: MutationCtx,
  row: Doc<"managedStorageMigrations"> | null,
  workspaceId: Id<"workspaces">,
  errorCode: string,
  failedKeys?: string[],
): Promise<void> {
  if (row !== null && row.status === "copying") {
    await ctx.db.patch(row._id, {
      status: "failed",
      errorCode,
      failedKeys,
      updatedAt: Date.now(),
    });
    // Leaving can run with nobody watching: tell the owner who started it.
    const kind = row.direction === "to_customer" ? handoffEmailKindFor(errorCode) : null;
    if (kind !== null) {
      await ctx.scheduler.runAfter(0, internal.functions.handoffEmail.sendHandoffEmail, {
        workspaceId,
        recipientUserId: row.startedBy,
        kind,
      });
    }
  }
  const plan = await ctx.db
    .query("workspacePlans")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (plan !== null) {
    await ctx.db.patch(plan._id, {
      managedProvisioning: "failed",
      managedProvisioningError: errorCode,
      managedProvisioningAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
}

/** Record a closed error code while keeping the source binding live. */
export async function failManagedStorageMigrationHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; errorCode: string; failedKeys?: string[] },
): Promise<null> {
  const row = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  await failMigrationRowAndPlan(ctx, row, args.workspaceId, args.errorCode, args.failedKeys);
  return null;
}

/**
 * The owner stops a move out of managed storage.
 *
 * Nothing is undone because nothing was switched: the managed bucket stayed
 * live throughout, and the files already copied stay in the customer's bucket,
 * which is theirs and not ours to empty. A later move into the same
 * destination carries on from them. Every scheduled page checks the row is
 * still `copying` before doing anything, so this is also what stops them.
 */
export async function cancelManagedStorageHandoffHandler(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<{ cancelled: boolean }> {
  const row = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (row === null || row.direction !== "to_customer" || row.status !== "copying") {
    return { cancelled: false };
  }
  // Once the final pass has said it is ready to switch, the switch is seconds
  // away and is the thing that makes the move true; it is not interrupted.
  if (row.readyToCutover === true) return { cancelled: false };
  await ctx.db.patch(row._id, {
    status: "failed",
    errorCode: "CANCELLED",
    failedKeys: undefined,
    updatedAt: Date.now(),
  });
  const plan = await ctx.db
    .query("workspacePlans")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (plan !== null) {
    // The managed storage the workspace runs on is fine; it is not a failure.
    await ctx.db.patch(plan._id, {
      managedProvisioning: "ready",
      managedProvisioningError: undefined,
      managedProvisioningAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  return { cancelled: true };
}
