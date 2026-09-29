import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { requireWorkspaceRole } from "../workspaceAuth";
import { noteCapFor, planIsPaying } from "../premium";
import { bindingIsManaged, deploymentOffersFreeManaged, planFor, statusOf } from "./plan";

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
  | "ALREADY_PREMIUM";

const REFUSAL_MESSAGES: Record<FreeManagedRefusal, string> = {
  FREE_TIER_UNAVAILABLE: "Free storage is not offered here. Connect a bucket of your own instead.",
  STORAGE_ALREADY_CONNECTED:
    "This workspace already has storage. Free storage is only for a workspace that has none yet.",
  ALREADY_PREMIUM: "This workspace is already on Premium.",
};

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

  const refusal = await freeManagedRefusal(ctx, workspaceId, plan);
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

/**
 * The note cap in force on this workspace, or `null` for none — what the
 * gateway and the console's file operations are handed beside the binding.
 */
export async function noteCapForWorkspace(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<number | null> {
  const plan = await planFor(ctx, workspaceId);
  if (plan === null) return null;
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return noteCapFor(plan, bindingIsManaged(binding, workspaceId));
}

/** How stale a capped context's count may be before opening it asks again. */
const NOTE_RECOUNT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Ask for a fresh note count on a context the free plan's cap applies to.
 *
 * The console calls this when an owner opens a capped context, so the count
 * behind "912 of 1,000 notes" includes what agents, email and other devices
 * added since. Owner-only, because the count is (`billing.status` returns
 * `notes` to owners alone). A context with no cap, or one counted within
 * `NOTE_RECOUNT_INTERVAL_MS`, schedules nothing: a reload must not become a
 * bucket walk. Scheduling is not calling — the walk runs in an internal
 * action, the only place a credential may be opened.
 */
export async function refreshNoteCountHandler(
  ctx: MutationCtx,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
): Promise<{ scheduled: boolean }> {
  await requireWorkspaceRole(ctx, workspaceId, userId, "owner");
  if ((await noteCapForWorkspace(ctx, workspaceId)) === null) return { scheduled: false };
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  const countedAt = binding?.noteCountedAt ?? 0;
  if (Date.now() - countedAt < NOTE_RECOUNT_INTERVAL_MS) return { scheduled: false };
  await ctx.scheduler.runAfter(0, internal.functions.provisioning.recountNotes, { workspaceId });
  return { scheduled: true };
}
