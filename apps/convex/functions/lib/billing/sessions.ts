import { v } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { Entitlements } from "../premium";
import { entitlementsValidator, planFor, requireUserId, selectionOf } from "./plan";

/**
 * Checkout and portal attempts (`billingSessions`), and resolving which plan
 * a Stripe event is about. Used by `functions/billing.ts`.
 */

/** How long a minted checkout or portal URL stays usable from our side. */
export const SESSION_TTL_MS = 15 * 60 * 1000;

/**
 * Is there a checkout attempt out there that somebody may be paying on?
 *
 * A `pending` row is one the minting action has not answered; a `ready` one is
 * a hosted page a person may be looking at. Either way a subscription can
 * appear at any moment, so the context is not free to be emptied. `failed` and
 * expired rows are neither.
 */
export async function hasLiveCheckout(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<boolean> {
  const now = Date.now();
  const rows = await ctx.db
    .query("billingSessions")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  return rows.some(
    (row) =>
      row.kind === "checkout" && row.status !== "failed" && row.expiresAt > now,
  );
}

export async function openSession(
  ctx: MutationCtx,
  input: {
    workspaceId: Id<"workspaces">;
    userId: Id<"users">;
    kind: "checkout" | "portal";
    /** The selection this attempt is buying. Absent for a portal attempt. */
    selected?: Entitlements;
    /** Where it started, which decides where Stripe returns to. */
    origin?: "settings" | "onboarding";
  },
): Promise<Id<"billingSessions">> {
  const now = Date.now();
  return await ctx.db.insert("billingSessions", {
    workspaceId: input.workspaceId,
    startedBy: input.userId,
    kind: input.kind,
    status: "pending",
    selectedAtCheckout: input.selected,
    origin: input.origin,
    expiresAt: now + SESSION_TTL_MS,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Which plan row this event is about, or `null`.
 *
 * Two ways in, in order of trust: our own checkout row, then a subscription id
 * we stored ourselves. There is deliberately no third — no lookup by customer
 * id, and none by anything in the event's `metadata`, because both would let a
 * field written outside this codebase choose a row.
 */
export async function resolvePlan(
  ctx: MutationCtx,
  facts: { checkoutRef?: string; subscriptionId?: string },
): Promise<{
  plan: Doc<"workspacePlans">;
  /** The attempt this event came home through, where it came through one. */
  session: Doc<"billingSessions"> | null;
} | null> {
  if (facts.checkoutRef !== undefined) {
    const sessionId = ctx.db.normalizeId("billingSessions", facts.checkoutRef);
    if (sessionId !== null) {
      const session = await ctx.db.get(sessionId);
      if (session !== null) {
        const existing = await planFor(ctx, session.workspaceId);
        if (existing !== null) return { plan: existing, session };
        // A context that pressed Upgrade always has a row — `startCheckout`
        // refuses an empty selection, and an empty selection is the only way
        // to get here without one. Handled anyway rather than thrown: a
        // webhook that raises on an unexpected shape is a webhook Stripe
        // retries forever.
        const now = Date.now();
        const planId = await ctx.db.insert("workspacePlans", {
          workspaceId: session.workspaceId,
          managedStorage: false,
          fastSearch: false,
          status: "none",
          createdAt: now,
          updatedAt: now,
        });
        const created = await ctx.db.get(planId);
        return created === null ? null : { plan: created, session };
      }
    }
  }

  if (facts.subscriptionId !== undefined) {
    /*
      `.first()` and not `.unique()`.

      Two plans can only carry one subscription id through a bug of ours, and
      `.unique()` turns that into a throw — which the route answers with a 500,
      which Stripe retries on a schedule that runs for days. A permanent 500
      loop on a webhook is a worse operational state than acting on the row we
      found: it blocks every *other* event for that endpoint behind a failure
      nobody can clear without a deploy. The duplicate is logged instead, which
      is the signal, and the first row still gets its update.
    */
    const matches = await ctx.db
      .query("workspacePlans")
      .withIndex("by_subscription", (q) =>
        q.eq("stripeSubscriptionId", facts.subscriptionId),
      )
      .take(2);
    if (matches.length > 1) {
      console.error("billing.duplicate_subscription_rows");
    }
    const found = matches[0];
    return found === undefined ? null : { plan: found, session: null };
  }

  return null;
}

/** `functions/billing.ts#billingSession`'s return validator and body. */
export const billingSessionReturns = v.union(
  v.null(),
  v.object({
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    kind: v.union(v.literal("checkout"), v.literal("portal")),
    url: v.optional(v.string()),
    errorCode: v.optional(v.string()),
  }),
);

export async function readBillingSession(
  ctx: QueryCtx,
  args: { sessionId: Id<"billingSessions"> },
) {
  const userId = await requireUserId(ctx);
  const row = await ctx.db.get(args.sessionId);
  // One answer for "no such row" and "not yours": a caller cannot act on the
  // difference and an attacker could.
  if (row === null || row.startedBy !== userId) return null;
  const expired = row.expiresAt <= Date.now();
  return {
    status: row.status,
    kind: row.kind,
    url: expired ? undefined : row.url,
    errorCode: row.errorCode,
  };
}

/** `functions/billing.ts#sessionForAction`'s return validator and body. */
export const sessionForActionReturns = v.union(
  v.null(),
  v.object({
    workspaceId: v.id("workspaces"),
    kind: v.union(v.literal("checkout"), v.literal("portal")),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    stripeCustomerId: v.optional(v.string()),
    selected: entitlementsValidator,
    /**
     * What the return URL is built from: where the attempt started, and the
     * name of the context it is for. The slug rather than the id, because a
     * URL addresses a context by name and never by a raw workspace id.
     */
    origin: v.union(v.literal("settings"), v.literal("onboarding")),
    slug: v.string(),
  }),
);

export async function readSessionForAction(
  ctx: QueryCtx,
  args: { sessionId: Id<"billingSessions"> },
) {
  const row = await ctx.db.get(args.sessionId);
  if (row === null) return null;
  const workspace = await ctx.db.get(row.workspaceId);
  /*
    No workspace, no attempt. The return URL is built from its name, and a
    context deleted between opening a checkout and minting the page would
    otherwise produce `/console/@?settings=premium` — a URL that resolves to
    nothing, handed to Stripe as the place to send somebody after they pay.
    The action reads this `null` as "skipped", which is what it is: there is
    nothing left to upgrade.
  */
  if (workspace === null) return null;
  const plan = await planFor(ctx, row.workspaceId);
  return {
    workspaceId: row.workspaceId,
    kind: row.kind,
    status: row.status,
    stripeCustomerId: plan?.stripeCustomerId,
    selected: selectionOf(plan),
    // A row written before `origin` existed is a settings attempt: it is
    // where the only checkout this product had could be started from.
    origin: row.origin ?? "settings",
    slug: workspace.slug,
  };
}
