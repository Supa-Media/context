/**
 * Recording a stopped migration, and the handler for
 * `managedProvisioning.failManagedStorageMigration`.
 *
 * Split out of `functions/managedProvisioning.ts` — see that file's header
 * comment on `provisionManagedStorage` for the whole flow this belongs to.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";

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
): Promise<void> {
  if (row !== null && row.status === "copying") {
    await ctx.db.patch(row._id, {
      status: "failed",
      errorCode,
      updatedAt: Date.now(),
    });
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
  args: { workspaceId: Id<"workspaces">; errorCode: string },
): Promise<null> {
  const row = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  await failMigrationRowAndPlan(ctx, row, args.workspaceId, args.errorCode);
  return null;
}
