/**
 * The handlers for `managedProvisioning.provisioningStanding` and
 * `recordManagedProvisioning`.
 *
 * Split out of `functions/managedProvisioning.ts` — see that file's header
 * comment on `provisionManagedStorage` for the whole flow this belongs to.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { managedBucketName } from "../managedStorage";
import { managedStorageEntitled } from "../premium";
import { deploymentOffersFreeManaged } from "../billing/plan";

/**
 * What the action needs to know before it mints anything.
 *
 * One query rather than three reads inside the action, so the preconditions
 * are asked as one consistent picture rather than three that can disagree.
 */
export async function provisioningStandingHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<{
  entitled: boolean;
  bindingId: Id<"storageBindings"> | null;
  migrationStatus?: "copying" | "failed";
  bindingIsManaged: boolean;
  ownerId: Id<"users"> | null;
} | null> {
  const workspace = await ctx.db.get(args.workspaceId);
  if (workspace === null) return null;
  const plan = await ctx.db
    .query("workspacePlans")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  const migration = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  const owner = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .collect();
  return {
    // Chosen *and* paying — or on the free tier while this deployment offers
    // it. `managedStorageEntitled` is the one place that decides; turning the
    // free tier off stops new free buckets and touches no existing one.
    entitled: managedStorageEntitled(plan, {
      freeTierOffered: deploymentOffersFreeManaged(),
    }),
    bindingId: binding?._id ?? null,
    migrationStatus: migration?.status,
    bindingIsManaged: binding?.bucket === managedBucketName(args.workspaceId),
    ownerId: owner.find((member) => member.role === "owner")?.userId ?? null,
  };
}

/** Where an attempt got to. Written by the action, read by the console. */
export async function recordManagedProvisioningHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    state: "running" | "ready" | "failed";
    errorCode?: string;
  },
): Promise<null> {
  const plan = await ctx.db
    .query("workspacePlans")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (plan === null) return null;
  await ctx.db.patch(plan._id, {
    managedProvisioning: args.state,
    managedProvisioningError: args.errorCode,
    managedProvisioningAt: Date.now(),
    updatedAt: Date.now(),
  });
  return null;
}
