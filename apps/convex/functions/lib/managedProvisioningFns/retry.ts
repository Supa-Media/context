/**
 * The handler for `managedProvisioning.retryManagedProvisioning`.
 *
 * Split out of `functions/managedProvisioning.ts` — see that file's header
 * comment on `provisionManagedStorage` for the whole flow this belongs to.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { requireWorkspaceRole } from "../workspaceAuth";

/**
 * Try again, from the screen that told them it had not worked.
 *
 * Owner-only, and it schedules rather than calls — this is a public mutation
 * and the action it starts opens a credential. Safe to press twice: the run it
 * schedules adopts the bucket it may already have created.
 */
export async function retryManagedProvisioningHandler(
  ctx: MutationCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
): Promise<null> {
  await requireWorkspaceRole(ctx, workspaceId, userId, "owner");
  const plan = await ctx.db
    .query("workspacePlans")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (plan === null || plan.managedStorage !== true) {
    throw new ConvexError({
      code: "NOT_ENTITLED",
      message: "This context is not set up for storage we keep.",
    });
  }
  await ctx.db.patch(plan._id, {
    managedProvisioning: "running",
    managedProvisioningError: undefined,
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(
    0,
    internal.functions.managedProvisioning.provisionManagedStorage,
    { workspaceId },
  );
  return null;
}
