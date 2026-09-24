import { v } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { requireWorkspaceAccess } from "../workspaceAuth";
import {
  MANAGED_STORAGE_CEILING_BYTES,
  PREMIUM_CURRENCY,
  PREMIUM_INTERVAL,
  PREMIUM_PRICE_CENTS,
  activeEntitlements,
} from "../premium";
import { stagingStorageIsFree } from "../managedStorage";
import { isProductionTestAccount } from "../testAccount";
import {
  bindingIsManaged,
  deploymentProvidesManagedStorage,
  deploymentSells,
  entitlementsValidator,
  planFor,
  requireUserId,
  selectionOf,
  statusOf,
  statusValidator,
} from "./plan";

/**
 * The body of `functions/billing.ts#status` — what the Premium section draws —
 * and its return validator. The query's own doc comment says who may read
 * what; the owner-only gates are in `readBillingStatus` below.
 */
export const billingStatusReturns = v.object({
  status: statusValidator,
  selected: entitlementsValidator,
  active: entitlementsValidator,
  canManage: v.boolean(),
  configured: v.boolean(),
  priceCents: v.number(),
  currency: v.string(),
  interval: v.string(),
  ceilingBytes: v.number(),
  /** Owner only. */
  currentPeriodEnd: v.optional(v.number()),
  cancelAtPeriodEnd: v.optional(v.boolean()),
  hasStripeCustomer: v.optional(v.boolean()),
  /**
   * Owner only, and it is a note count rather than a byte figure because a
   * byte figure is not measured anywhere yet — see the panel's copy, which
   * says so rather than implying a meter exists.
   */
  notes: v.optional(v.number()),
  notesTruncated: v.optional(v.boolean()),
  notesCountedAt: v.optional(v.number()),
  /** Whether this context's storage is a bucket we run. */
  storageIsManaged: v.boolean(),
  /**
   * Whether this deployment can provide managed storage at all — a price to
   * charge *and* somewhere to put the bucket. The console does not offer
   * what cannot be delivered.
   */
  managedStorageAvailable: v.boolean(),
  /**
   * Where making this context's managed bucket got to, when it was asked
   * for. Absent for every context that never bought managed storage.
   *
   * The `failed` case is the one that has to reach the screen: without it a
   * person who paid two minutes ago cannot tell a slow webhook from a bucket
   * that is never going to appear.
   */
  managedProvisioning: v.optional(
    v.union(v.literal("running"), v.literal("ready"), v.literal("failed")),
  ),
  /** Ours, from a closed set — never Cloudflare's text. Owner only. */
  managedProvisioningError: v.optional(v.string()),
  /** Copy progress for an existing bucket moving into managed storage. */
  managedMigrationObjectsCopied: v.optional(v.number()),
  managedMigrationObjectsTotal: v.optional(v.number()),
  managedMigrationObjectsProcessed: v.optional(v.number()),
  managedMigrationPhase: v.optional(
    v.union(
      v.literal("count"),
      v.literal("copy"),
      v.literal("verify_source"),
      v.literal("verify_target"),
    ),
  ),
  /** Exact production CUJ account; owner only. */
  isTestAccount: v.optional(v.boolean()),
  stagingFreeStorage: v.optional(v.boolean()),
});

export async function readBillingStatus(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
) {
  const userId = await requireUserId(ctx);
  const { membership } = await requireWorkspaceAccess(
    ctx,
    args.workspaceId,
    userId,
  );
  const isOwner = membership.role === "owner";
  const user = await ctx.db.get(userId);

  const plan = await planFor(ctx, args.workspaceId);
  const planStatus = statusOf(plan);
  const selected = selectionOf(plan);

  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  const migration = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();

  return {
    status: planStatus,
    selected,
    active: activeEntitlements(selected, planStatus),
    canManage: isOwner,
    // Reading the env var, never the key: whether this deployment can sell
    // is a configuration fact, and a public function may not reach the key
    // that would make the answer complete. A deployment with a price id and
    // no payment key fails at the checkout with our own sentence.
    configured: stagingStorageIsFree() || deploymentSells(),
    priceCents: stagingStorageIsFree() ? 0 : PREMIUM_PRICE_CENTS,
    currency: PREMIUM_CURRENCY,
    interval: PREMIUM_INTERVAL,
    ceilingBytes: MANAGED_STORAGE_CEILING_BYTES,
    currentPeriodEnd: isOwner ? plan?.currentPeriodEnd : undefined,
    cancelAtPeriodEnd: isOwner ? plan?.cancelAtPeriodEnd : undefined,
    // The id itself is never returned — only whether one exists, which is
    // what decides whether "Manage billing" is drawn.
    hasStripeCustomer: isOwner
      ? plan?.stripeCustomerId !== undefined
      : undefined,
    notes: isOwner ? binding?.noteCount : undefined,
    notesTruncated: isOwner ? binding?.noteCountTruncated : undefined,
    notesCountedAt: isOwner ? binding?.noteCountedAt : undefined,
    storageIsManaged: bindingIsManaged(binding, args.workspaceId),
    managedStorageAvailable: deploymentProvidesManagedStorage(),
    managedProvisioning: plan?.managedProvisioning,
    // Owner only, with the rest of the money fields: a member cannot act on
    // it and does not need to know which of our systems refused.
    managedProvisioningError: isOwner
      ? plan?.managedProvisioningError
      : undefined,
    managedMigrationObjectsCopied: isOwner
      ? migration?.objectsCopied
      : undefined,
    managedMigrationObjectsTotal: isOwner
      ? migration?.objectsTotal
      : undefined,
    managedMigrationObjectsProcessed: isOwner
      ? migration?.objectsProcessedInPhase
      : undefined,
    managedMigrationPhase: isOwner ? migration?.phase : undefined,
    stagingFreeStorage: stagingStorageIsFree(),
    isTestAccount: isOwner ? isProductionTestAccount(user) : undefined,
  };
}
