import { internal } from "../../../_generated/api";
import type { Doc } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { planIsPaying } from "../premium";
import { bindingIsManaged, statusOf } from "./plan";

/**
 * Start moving a paying workspace onto storage we run, once its owner has
 * chosen it (Settings › Storage).
 *
 * The webhook starts the same run when a payment lands with managed storage
 * already chosen. This covers the other order: a workspace already on Premium,
 * in the owner's own bucket, choosing ours afterwards. Without it the choice
 * waited for Stripe's next event, usually the renewal, while the Premium page
 * said the bucket was being created. The run copies and verifies before it
 * switches anything, so the owner's bucket stays connected and untouched until
 * the copy matches. A run already under way is left alone.
 */
export async function startManagedMoveIfChosen(
  ctx: MutationCtx,
  plan: Doc<"workspacePlans">,
): Promise<boolean> {
  if (!plan.managedStorage || !planIsPaying(statusOf(plan))) return false;
  if (plan.managedProvisioning === "running") return false;
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", plan.workspaceId))
    .unique();
  if (bindingIsManaged(binding, plan.workspaceId)) return false;
  await ctx.db.patch(plan._id, { managedProvisioning: "running" });
  await ctx.scheduler.runAfter(
    0,
    internal.functions.managedProvisioning.provisionManagedStorage,
    { workspaceId: plan.workspaceId },
  );
  return true;
}
