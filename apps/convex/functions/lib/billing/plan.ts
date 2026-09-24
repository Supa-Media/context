import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { stripePriceId, type Entitlements, type PlanStatus } from "../premium";
import { managedBucketName, managedAccountId, stagingStorageIsFree } from "../managedStorage";

/**
 * What a context's plan row says, and what this deployment can sell.
 *
 * Reads and pure derivations shared by the Convex surface in
 * `functions/billing.ts`. Nothing here schedules, calls another Convex
 * function, or decides whether anybody may leave with their notes — see that
 * file's header, "What this file may never grow".
 */

export async function requireUserId(ctx: QueryCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({
      code: "NOT_AUTHENTICATED",
      message: "Sign in first.",
    });
  }
  return userId;
}

export async function planFor(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"workspacePlans"> | null> {
  return await ctx.db
    .query("workspacePlans")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/** No row is the ordinary state: free, nothing selected, nobody paying. */
export function selectionOf(plan: Doc<"workspacePlans"> | null): Entitlements {
  return {
    managedStorage: plan?.managedStorage ?? false,
    fastSearch: plan?.fastSearch ?? false,
  };
}

export function statusOf(plan: Doc<"workspacePlans"> | null): PlanStatus {
  return plan?.status ?? "none";
}

/**
 * Is this context's storage a bucket we run?
 *
 * Derived from the bucket's name rather than stored as a flag, because the
 * name is already derived from the workspace id and cannot be anything else:
 * `managedBucketName` is deterministic and total, so one comparison answers it
 * with nothing to keep in sync. A flag would be a second copy of a fact, and
 * the direction that copy drifts is a customer's own bucket being treated as
 * ours.
 *
 * `bindStorage` refuses an endpoint addressing the managed account, so a
 * customer cannot get a BYO binding that answers true here by naming their own
 * bucket after a workspace id: the name alone would collide only inside our own
 * account, which they cannot reach.
 */
export function bindingIsManaged(
  binding: Doc<"storageBindings"> | null,
  workspaceId: Id<"workspaces">,
): boolean {
  if (binding === null) return false;
  return binding.bucket === managedBucketName(workspaceId);
}

/**
 * Does this deployment sell anything?
 *
 * `stripePriceId` **throws** on a value that is present and malformed, which is
 * the right answer where it is read — the minting action turns it into a
 * recorded `NOT_CONFIGURED` an operator can see. It is the wrong answer in a
 * public query: an operator typo in one environment variable would throw for
 * every member of every context on this deployment and take the whole Premium
 * section down with it, on a read that changes nothing.
 *
 * So the read degrades to "this deployment does not sell", which is what a
 * misconfigured deployment *is* from a customer's side, and the loudness stays
 * where it can be acted on — the deployment's own log, and the failed attempt
 * row the moment anybody presses Upgrade.
 */
export function deploymentSells(): boolean {
  try {
    return stripePriceId() !== null;
  } catch {
    console.error("billing.price_id_malformed");
    return false;
  }
}

/**
 * Can this deployment actually *give* somebody managed storage?
 *
 * Selling is not the same question. A deployment with a price id can take a
 * payment; one without a customer-data account has nowhere to put the bucket
 * that payment buys. Offering managed storage on such a deployment would be
 * taking $5 for something that cannot be delivered, which is the worst
 * failure this flow has — so the answer is a fact the console reads *before*
 * drawing the option, and a first run simply does not show it where this is
 * false.
 *
 * Malformed is false rather than a throw, for the reason the price id learned
 * the hard way: this is read by `status`, which every member of every context
 * calls, and an operator's typo must not take that query down for all of them.
 * The throw is still the right behaviour where provisioning itself reads it.
 */
export function deploymentProvidesManagedStorage(): boolean {
  if (!stagingStorageIsFree() && !deploymentSells()) return false;
  try {
    return managedAccountId() !== null;
  } catch {
    console.error("billing.managed_account_malformed");
    return false;
  }
}

export const statusValidator = v.union(
  v.literal("none"),
  v.literal("active"),
  v.literal("past_due"),
  v.literal("canceled"),
  v.literal("unknown"),
);

export const entitlementsValidator = v.object({
  managedStorage: v.boolean(),
  fastSearch: v.boolean(),
});
