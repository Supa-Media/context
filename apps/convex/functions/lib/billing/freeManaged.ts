import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { requireWorkspaceRole } from "../workspaceAuth";
import { FREE_MANAGED_PER_ACCOUNT, planIsPaying } from "../premium";
import { deploymentOffersFreeManaged, planFor, statusOf } from "./plan";

/**
 * The free managed tier: a bucket we run, no card, a note cap.
 *
 * The body of `functions/billing.ts#startFreeManaged` and the eligibility the
 * status query reports, kept here so the two cannot disagree about who may
 * start it. `docs/decisions/billing.md`, "The free managed tier".
 */

export type FreeManagedRefusal =
  | "FREE_TIER_UNAVAILABLE"
  | "STORAGE_ALREADY_CONNECTED"
  | "ALREADY_PREMIUM"
  | "FREE_TIER_LIMIT";

const REFUSAL_MESSAGES: Record<FreeManagedRefusal, string> = {
  FREE_TIER_UNAVAILABLE: "Free storage is not offered here. Connect a bucket of your own instead.",
  STORAGE_ALREADY_CONNECTED:
    "This workspace already has storage. Free storage is only for a workspace that has none yet.",
  ALREADY_PREMIUM: "This workspace is already on Premium.",
  FREE_TIER_LIMIT:
    "You already have a workspace on free storage. Connect a bucket of your own for this one, or choose Premium.",
};

/**
 * How many workspaces this person owns that started on the free tier, not
 * counting `except`.
 *
 * Counted through ownership rather than through who pressed the button: the
 * allowance is "one free bucket per account", and an account is what owns a
 * workspace. Deleting the workspace deletes its plan row, which returns the
 * allowance — the bucket it paid for is gone with it.
 */
async function freeWorkspacesOwnedBy(
  ctx: QueryCtx,
  userId: Id<"users">,
  except: Id<"workspaces">,
): Promise<number> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  let count = 0;
  for (const membership of memberships) {
    if (membership.role !== "owner" || membership.workspaceId === except) continue;
    const plan = await planFor(ctx, membership.workspaceId);
    if (plan?.freeManaged === true) count += 1;
  }
  return count;
}

/** Already on the free tier, with its bucket made or on the way. */
function alreadyStarted(plan: Doc<"workspacePlans"> | null): boolean {
  return plan?.freeManaged === true && plan.managedStorage === true;
}

/**
 * Why this owner may not start the free tier here, or `null` where they may.
 *
 * Assumes the caller has already checked the role — the status query asks it
 * only for owners, and the mutation only after `requireWorkspaceRole`.
 */
export async function freeManagedRefusal(
  ctx: QueryCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
  plan: Doc<"workspacePlans"> | null,
): Promise<FreeManagedRefusal | null> {
  if (!deploymentOffersFreeManaged()) return "FREE_TIER_UNAVAILABLE";
  if (planIsPaying(statusOf(plan))) return "ALREADY_PREMIUM";
  // Moving an existing bucket into managed storage is a verified copy
  // (`managedStorageMigrations`); this entry point never does it.
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (binding !== null) return "STORAGE_ALREADY_CONNECTED";
  if ((await freeWorkspacesOwnedBy(ctx, userId, workspaceId)) >= FREE_MANAGED_PER_ACCOUNT) {
    return "FREE_TIER_LIMIT";
  }
  return null;
}

export async function startFreeManagedHandler(
  ctx: MutationCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
): Promise<{ started: true }> {
  await requireWorkspaceRole(ctx, workspaceId, userId, "owner");
  const plan = await planFor(ctx, workspaceId);

  // A second press — a double tap, a reload — is an answer, not a second bucket.
  if (alreadyStarted(plan)) return { started: true };

  const refusal = await freeManagedRefusal(ctx, userId, workspaceId, plan);
  if (refusal !== null) {
    throw new ConvexError({ code: refusal, message: REFUSAL_MESSAGES[refusal] });
  }

  const now = Date.now();
  if (plan === null) {
    await ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: true,
      fastSearch: false,
      status: "none",
      freeManaged: true,
      managedProvisioning: "running",
      createdAt: now,
      updatedAt: now,
    });
  } else {
    // A selection made earlier and never paid for stays as it was; fast search
    // is a paid entitlement and is not switched on by this.
    await ctx.db.patch(plan._id, {
      managedStorage: true,
      freeManaged: true,
      managedProvisioning: "running",
      managedProvisioningError: undefined,
      updatedAt: now,
    });
  }

  await ctx.scheduler.runAfter(
    0,
    internal.functions.managedProvisioning.provisionManagedStorage,
    { workspaceId },
  );
  await recordAudit(ctx, {
    workspaceId,
    actorUserId: userId,
    action: "billing.free_managed_started",
  });
  return { started: true };
}
