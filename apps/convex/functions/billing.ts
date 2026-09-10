/**
 * Premium, in the control plane.
 *
 * What Premium *is* — the price, the ceiling, the two entitlements and the AND
 * that decides what a context actually gets — is `lib/premium.ts`. What Stripe
 * *sends* is `lib/stripe.ts`. This file is the surface: one query the settings
 * screen reads, three mutations an **owner** calls, and the internal functions
 * the webhook and the Stripe actions run through.
 *
 * ## The shape, and why it is not simpler
 *
 * Opening Stripe's hosted checkout needs the payment key. Only an action may
 * open a credential, and `__tests__/structure.test.ts` refuses any public
 * function whose call graph reaches `decryptSecret` — so a public action that
 * returned a checkout URL would be exactly the violation that guard exists to
 * catch. The way through is the one the connect flow already uses:
 * **scheduling is not calling**. `startCheckout` writes a `billingSessions`
 * row, schedules the minting action in `functions/billingStripe.ts`, and
 * returns the row's id; the action mints the URL and patches the row; the
 * console watches the row.
 *
 * (That sentence names the module rather than the function reference on
 * purpose: `structure.test.ts` reads a module's unattributed text for
 * `internal.…` references and attributes them to *every* export, so a fully
 * qualified name in a header comment is a real call edge as far as the
 * credential graph is concerned — and would taint this whole file with a
 * decrypt it does not perform.)
 *
 * ## Owner-only, and why that is not the same as write access
 *
 * `requireWorkspaceRole(..., "owner")` on all three mutations. An editor may
 * write every note in a context; committing somebody's card to $20 a month, or
 * changing what the context is paying for, is a different authority — the same
 * argument `fastSearch.ts` makes about deciding where a copy of the notes is
 * kept.
 *
 * ## What this file may never grow
 *
 * A function that consults the plan to decide whether somebody may export,
 * download, or hand over their bucket. The exit is free, identical on both
 * plans, and works after a cancellation (non-negotiable #1). Cancelling makes
 * a context read-only and exportable; it never deletes, and there is no
 * deletion path here at all.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { recordAudit } from "./lib/audit";
import { requireWorkspaceAccess, requireWorkspaceRole } from "./lib/workspaceAuth";
import {
  MANAGED_STORAGE_CEILING_BYTES,
  PREMIUM_CURRENCY,
  PREMIUM_INTERVAL,
  PREMIUM_PRICE_CENTS,
  activeEntitlements,
  hasAnyEntitlement,
  planIsPaying,
  planStatusFromStripe,
  stripePriceId,
  type Entitlements,
  type PlanStatus,
} from "./lib/premium";
import { MANAGED_BUCKET_PREFIX, managedAccountId } from "./lib/managedStorage";
import { isHandledEventType, type StripeEventFacts } from "./lib/stripe";

/** How long a minted checkout or portal URL stays usable from our side. */
const SESSION_TTL_MS = 15 * 60 * 1000;

async function requireUserId(ctx: QueryCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Sign in first." });
  }
  return userId;
}

async function planFor(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"workspacePlans"> | null> {
  return await ctx.db
    .query("workspacePlans")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/** No row is the ordinary state: free, nothing selected, nobody paying. */
function selectionOf(plan: Doc<"workspacePlans"> | null): Entitlements {
  return {
    managedStorage: plan?.managedStorage ?? false,
    fastSearch: plan?.fastSearch ?? false,
  };
}

function statusOf(plan: Doc<"workspacePlans"> | null): PlanStatus {
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
function bindingIsManaged(
  binding: Doc<"storageBindings"> | null,
  workspaceId: Id<"workspaces">,
): boolean {
  if (binding === null) return false;
  return binding.bucket === `${MANAGED_BUCKET_PREFIX}${String(workspaceId)}`;
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
function deploymentSells(): boolean {
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
 * taking $20 for something that cannot be delivered, which is the worst
 * failure this flow has — so the answer is a fact the console reads *before*
 * drawing the option, and a first run simply does not show it where this is
 * false.
 *
 * Malformed is false rather than a throw, for the reason the price id learned
 * the hard way: this is read by `status`, which every member of every context
 * calls, and an operator's typo must not take that query down for all of them.
 * The throw is still the right behaviour where provisioning itself reads it.
 */
function deploymentProvidesManagedStorage(): boolean {
  if (!deploymentSells()) return false;
  try {
    return managedAccountId() !== null;
  } catch {
    console.error("billing.managed_account_malformed");
    return false;
  }
}

/**
 * Is there a checkout attempt out there that somebody may be paying on?
 *
 * A `pending` row is one the minting action has not answered; a `ready` one is
 * a hosted page a person may be looking at. Either way a subscription can
 * appear at any moment, so the context is not free to be emptied. `failed` and
 * expired rows are neither.
 */
async function hasLiveCheckout(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<boolean> {
  const now = Date.now();
  const rows = await ctx.db
    .query("billingSessions")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  return rows.some(
    (row) => row.kind === "checkout" && row.status !== "failed" && row.expiresAt > now,
  );
}

const statusValidator = v.union(
  v.literal("none"),
  v.literal("active"),
  v.literal("past_due"),
  v.literal("canceled"),
  v.literal("unknown"),
);

const entitlementsValidator = v.object({
  managedStorage: v.boolean(),
  fastSearch: v.boolean(),
});

/**
 * What the Premium section draws.
 *
 * Readable by any member: knowing whether the context they are in is on a paid
 * plan is not privileged, and a member who cannot see it would be told nothing
 * about why fast search is or is not available to this context.
 *
 * **The money is owner-only.** `stripeCustomerId`, the renewal date and the
 * note census are absent for anyone but an owner — the same gate, and the same
 * reasoning, `fastSearch.status` applies to its backfill counters: a member may
 * read only the `team` tier, so a total that includes private notes lets them
 * derive how much they are not being shown.
 *
 * `configured` says whether this deployment sells anything at all. A
 * self-hoster has no price id and no payment key, and must be told "this
 * deployment does not offer Premium" rather than shown a button that fails.
 */
export const status = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
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
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { membership } = await requireWorkspaceAccess(ctx, args.workspaceId, userId);
    const isOwner = membership.role === "owner";

    const plan = await planFor(ctx, args.workspaceId);
    const planStatus = statusOf(plan);
    const selected = selectionOf(plan);

    const binding = await ctx.db
      .query("storageBindings")
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
      configured: deploymentSells(),
      priceCents: PREMIUM_PRICE_CENTS,
      currency: PREMIUM_CURRENCY,
      interval: PREMIUM_INTERVAL,
      ceilingBytes: MANAGED_STORAGE_CEILING_BYTES,
      currentPeriodEnd: isOwner ? plan?.currentPeriodEnd : undefined,
      cancelAtPeriodEnd: isOwner ? plan?.cancelAtPeriodEnd : undefined,
      // The id itself is never returned — only whether one exists, which is
      // what decides whether "Manage billing" is drawn.
      hasStripeCustomer: isOwner ? plan?.stripeCustomerId !== undefined : undefined,
      notes: isOwner ? binding?.noteCount : undefined,
      notesTruncated: isOwner ? binding?.noteCountTruncated : undefined,
      notesCountedAt: isOwner ? binding?.noteCountedAt : undefined,
      storageIsManaged: bindingIsManaged(binding, args.workspaceId),
      managedStorageAvailable: deploymentProvidesManagedStorage(),
      managedProvisioning: plan?.managedProvisioning,
      // Owner only, with the rest of the money fields: a member cannot act on
      // it and does not need to know which of our systems refused.
      managedProvisioningError: isOwner ? plan?.managedProvisioningError : undefined,
    };
  },
});

/**
 * Choose what this context is paying for.
 *
 * Stored whether or not anybody is paying, so the choice survives a lapse and
 * resuming is a payment rather than a re-selection. It reaches Stripe on the
 * next checkout and never on its own: turning a toggle here does not change a
 * price, because there is only one.
 *
 * **Both off is refused while a subscription is live**, and the refusal names
 * the alternative. Silently keeping a $20 subscription that entitles nothing
 * is the worst of the three possible behaviours; cancelling on somebody's
 * behalf because they moved a switch is the second worst. Cancelling is the
 * portal's, deliberately — it is where the card and the invoices already are.
 */
export const setEntitlements = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    managedStorage: v.boolean(),
    fastSearch: v.boolean(),
  },
  returns: v.object({ selected: entitlementsValidator }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

    const selected: Entitlements = {
      managedStorage: args.managedStorage,
      fastSearch: args.fastSearch,
    };
    const plan = await planFor(ctx, args.workspaceId);
    const planStatus = statusOf(plan);

    /*
      Refused while anybody is on the hook for a payment — which is not the
      same question as "is this plan paying right now".

      It used to read `planIsPaying` alone, and between pressing Upgrade and
      the webhook landing the status is still `none`: emptying both boxes was
      allowed, and the plan then activated entitling nothing. $20 a month for
      zero, and the window is however long Stripe takes.

      A live checkout attempt is therefore part of the condition. The snapshot
      in `applyStripeEvent` is the belt to this refusal's braces, for the race
      no mutation-time check can catch.
    */
    const owing = planIsPaying(planStatus) || (await hasLiveCheckout(ctx, args.workspaceId));
    if (!hasAnyEntitlement(selected) && owing) {
      throw new ConvexError({
        code: "ENTITLEMENTS_EMPTY",
        message:
          "A Premium context includes at least one of managed storage and fast search. " +
          "To stop paying, cancel through Manage billing — your notes stay where they are.",
      });
    }

    const now = Date.now();
    if (plan === null) {
      await ctx.db.insert("workspacePlans", {
        workspaceId: args.workspaceId,
        managedStorage: selected.managedStorage,
        fastSearch: selected.fastSearch,
        status: "none",
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(plan._id, {
        managedStorage: selected.managedStorage,
        fastSearch: selected.fastSearch,
        updatedAt: now,
      });
    }

    /*
      A live attempt's snapshot follows the choice.

      `startCheckout` reuses a live attempt rather than opening a second, so
      without this the snapshot stayed whatever had been chosen at the FIRST
      press — and a restore would then put back something the owner had since
      changed their mind about, which is worse than putting back the right one.
      It means "the last thing they chose while this attempt was open".
    */
    const openAttempts = await ctx.db
      .query("billingSessions")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    for (const attempt of openAttempts) {
      if (attempt.kind !== "checkout") continue;
      if (attempt.status === "failed" || attempt.expiresAt <= now) continue;
      await ctx.db.patch(attempt._id, { selectedAtCheckout: selected });
    }

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "billing.entitlements_set",
      details: {
        managedStorage: selected.managedStorage,
        fastSearch: selected.fastSearch,
      },
    });

    return { selected };
  },
});

/**
 * Ask for a Stripe Checkout URL.
 *
 * Returns the id of a row, not a URL — see the header. The row is the console's
 * handle on an attempt it cannot otherwise watch, and the id is meaningless to
 * anybody but its owner.
 */
export const startCheckout = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    /**
     * Where this attempt started. It decides where Stripe returns to, and
     * nothing else — a first run comes back to the flow it is standing in,
     * settings comes back to the section it was opened from.
     */
    origin: v.optional(v.union(v.literal("settings"), v.literal("onboarding"))),
  },
  returns: v.object({ sessionId: v.id("billingSessions") }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

    const plan = await planFor(ctx, args.workspaceId);
    if (!hasAnyEntitlement(selectionOf(plan))) {
      throw new ConvexError({
        code: "ENTITLEMENTS_EMPTY",
        message: "Choose managed storage, fast search, or both before upgrading.",
      });
    }
    if (planIsPaying(statusOf(plan))) {
      throw new ConvexError({
        code: "ALREADY_PREMIUM",
        message: "This context is already on Premium.",
      });
    }

    /*
      A live attempt is reused rather than joined by a second one.

      Two presses — a double tap, a reload that lost the id, two tabs — used to
      mean two Checkout Sessions, and a person who paid on both would have two
      subscriptions for one bucket, only the second of which this control plane
      would know about. The first would go on being charged with nothing here
      naming it. Stripe cannot dedupe that for us: two sessions built from the
      same parameters are two legitimate intents as far as it is concerned.

      Scoped to the person who started it as well as to the context, because a
      checkout URL is a capability: handing a co-owner the page minted for
      somebody else is a different bug wearing this fix's clothes.

      This does not make a double subscription impossible — two tabs opened
      before either was recorded still race — but it removes every ordinary way
      to reach it.
    */
    const live = await ctx.db
      .query("billingSessions")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    const now = Date.now();
    const reusable = live.find(
      (row) =>
        row.kind === "checkout" &&
        row.startedBy === userId &&
        row.status !== "failed" &&
        row.expiresAt > now,
    );
    if (reusable !== undefined) return { sessionId: reusable._id };

    const sessionId = await openSession(ctx, {
      workspaceId: args.workspaceId,
      userId,
      kind: "checkout",
      // What this attempt is buying, frozen now. See `selectedAtCheckout`.
      selected: selectionOf(plan),
      origin: args.origin,
    });

    await ctx.scheduler.runAfter(
      0,
      internal.functions.billingStripe.createCheckoutSession,
      { sessionId },
    );
    return { sessionId };
  },
});

/**
 * Ask for a Stripe customer-portal URL.
 *
 * The payment UI deliberately leaves the app: the card, the invoices and the
 * cancellation live at Stripe, and re-implementing any of them here would mean
 * holding card data we have no business holding.
 */
export const startPortal = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ sessionId: v.id("billingSessions") }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

    const plan = await planFor(ctx, args.workspaceId);
    if (plan?.stripeCustomerId === undefined) {
      throw new ConvexError({
        code: "NO_CUSTOMER",
        message: "There is nothing to manage yet for this context.",
      });
    }

    const sessionId = await openSession(ctx, {
      workspaceId: args.workspaceId,
      userId,
      kind: "portal",
    });

    await ctx.scheduler.runAfter(
      0,
      internal.functions.billingStripe.createPortalSession,
      { sessionId },
    );
    return { sessionId };
  },
});

async function openSession(
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
 * Watch one attempt.
 *
 * **Readable only by the person who started it**, and not merely by an owner
 * of the workspace: a Stripe checkout URL is a capability — anybody holding it
 * can put a card against this context — so it goes back to the browser that
 * asked and nowhere else. An expired row hands back no URL, whatever it holds.
 */
export const billingSession = query({
  args: { sessionId: v.id("billingSessions") },
  returns: v.union(
    v.null(),
    v.object({
      status: v.union(v.literal("pending"), v.literal("ready"), v.literal("failed")),
      kind: v.union(v.literal("checkout"), v.literal("portal")),
      url: v.optional(v.string()),
      errorCode: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
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
  },
});

/* ------------------------------------------------------------------------ *
 * Internal — the webhook's and the Stripe actions' side.
 * ------------------------------------------------------------------------ */

/** The attempt an action is working on, plus what it needs to mint a URL. */
export const sessionForAction = internalQuery({
  args: { sessionId: v.id("billingSessions") },
  returns: v.union(
    v.null(),
    v.object({
      workspaceId: v.id("workspaces"),
      kind: v.union(v.literal("checkout"), v.literal("portal")),
      status: v.union(v.literal("pending"), v.literal("ready"), v.literal("failed")),
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
  ),
  handler: async (ctx, args) => {
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
  },
});

/** What the minting action learned: a URL, or our own reason it failed. */
export const recordSessionResult = internalMutation({
  args: {
    sessionId: v.id("billingSessions"),
    url: v.optional(v.string()),
    errorCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.sessionId);
    if (row === null) return null;
    await ctx.db.patch(args.sessionId, {
      status: args.url === undefined ? "failed" : "ready",
      url: args.url,
      errorCode: args.errorCode,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Apply one signed Stripe event.
 *
 * The route has already proved the body came from Stripe. What is left is the
 * part a signature cannot help with: **which context does this event belong
 * to, and is it still news?**
 *
 * ## The workspace is never read out of the event
 *
 * A completed checkout carries `client_reference_id`, which is the id of the
 * `billingSessions` row *we* wrote when the owner pressed Upgrade. The
 * workspace is read off that row. Every later event is matched by
 * `stripeSubscriptionId`, which we stored from the checkout. So an identifier
 * arriving from outside can only ever select a row we created — the same rule
 * `expectedWorkspaceId` follows at the gateway, for the same reason.
 *
 * ## Delivery is at-least-once and out of order
 *
 * The same event id twice is a no-op. An event created before the last one
 * applied is a no-op too: without that, a retried `subscription.updated` from
 * before a cancellation quietly re-activates a cancelled plan. Equal
 * timestamps are applied rather than dropped — Stripe stamps at second
 * granularity and two real events routinely share one.
 */
export const applyStripeEvent = internalMutation({
  args: {
    id: v.string(),
    type: v.string(),
    createdSeconds: v.number(),
    customerId: v.optional(v.string()),
    subscriptionId: v.optional(v.string()),
    checkoutRef: v.optional(v.string()),
    rawStatus: v.optional(v.string()),
    sessionStatus: v.optional(v.string()),
    paymentStatus: v.optional(v.string()),
    currentPeriodEndSeconds: v.optional(v.number()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
  },
  returns: v.object({ applied: v.boolean(), reason: v.string() }),
  handler: async (ctx, args) => {
    if (!isHandledEventType(args.type)) {
      return { applied: false, reason: "unhandled_type" };
    }

    const resolved = await resolvePlan(ctx, args);
    if (resolved === null) return { applied: false, reason: "no_context" };
    const { plan, session } = resolved;

    /*
      Two halves of one guard, and the first one used to be a single id.

      `lastEventAt` drops anything created before the newest event applied.
      `lastEventIds` drops a redelivery of anything applied *at* that second —
      which is where Stripe stamps `updated` and `deleted` together, and where
      one remembered id plus a strict `<` let a retried `updated` re-activate a
      plan somebody had cancelled. See the schema for the full sequence.
    */
    if (args.createdSeconds < (plan.lastEventAt ?? Number.NEGATIVE_INFINITY)) {
      return { applied: false, reason: "out_of_order" };
    }
    const atSameSecond = plan.lastEventAt === args.createdSeconds;
    if (atSameSecond && (plan.lastEventIds ?? []).includes(args.id)) {
      return { applied: false, reason: "already_applied" };
    }

    /*
      A checkout session and a subscription have different vocabularies about
      different objects — `complete`/`open`/`expired` against
      `active`/`past_due`/`canceled` — and reading one as the other maps a paid
      checkout to a status this build has never heard of. Written the wrong way
      round first; `billing.test.ts` caught it.

      So a session is judged on its own words: it turns the plan on only where
      Stripe says it completed **and** was paid for. `no_payment_required` is a
      100%-discount coupon or a trial and is as paid as it is going to get.
      Anything else is left alone, and the subscription events that follow say
      what actually happened.
    */
    let status: PlanStatus;
    if (args.type === "customer.subscription.deleted") {
      status = "canceled";
    } else if (args.rawStatus !== undefined) {
      status = planStatusFromStripe(args.rawStatus);
    } else if (
      args.sessionStatus === "complete" &&
      (args.paymentStatus === "paid" || args.paymentStatus === "no_payment_required")
    ) {
      status = "active";
    } else {
      return { applied: false, reason: "not_paid" };
    }

    /*
      NOBODY EVER PAYS FOR NOTHING.

      `setEntitlements` refuses an empty selection while a checkout is in
      flight, which closes the ordinary path. This is the belt to that: two
      tabs, or a mutation landing between the press and the webhook, can still
      leave the plan empty at the moment it activates — $20 a month entitling
      nothing.

      What somebody paid for is what they chose **at checkout**, so the attempt
      row's snapshot is restored, and only when the live selection is empty. A
      person who unticked one of two between pressing Upgrade and paying meant
      that, and keeps it; a person who ended up with neither cannot have meant
      it, because the mutation would have refused them.
    */
    const emptyAtActivation =
      planIsPaying(status) && !hasAnyEntitlement(selectionOf(plan));
    const restored =
      emptyAtActivation && session?.selectedAtCheckout !== undefined
        ? session.selectedAtCheckout
        : null;
    if (restored !== null) {
      console.error("billing.selection_restored_from_checkout");
    }

    await ctx.db.patch(plan._id, {
      status,
      managedStorage: restored?.managedStorage ?? plan.managedStorage,
      fastSearch: restored?.fastSearch ?? plan.fastSearch,
      stripeCustomerId: args.customerId ?? plan.stripeCustomerId,
      stripeSubscriptionId: args.subscriptionId ?? plan.stripeSubscriptionId,
      currentPeriodEnd: args.currentPeriodEndSeconds ?? plan.currentPeriodEnd,
      cancelAtPeriodEnd: args.cancelAtPeriodEnd ?? plan.cancelAtPeriodEnd,
      // Appended while the second matches, replaced when it moves. That reset
      // is what bounds the set: it never holds more than the events Stripe
      // emits for one subscription inside one second.
      lastEventIds: atSameSecond
        ? [...(plan.lastEventIds ?? []), args.id]
        : [args.id],
      lastEventAt: args.createdSeconds,
      updatedAt: Date.now(),
    });

    await recordAudit(ctx, {
      workspaceId: plan.workspaceId,
      // No actor: Stripe is not a person and not a member. The event type is
      // the record of what happened, and the owner's own act is already
      // audited by `setEntitlements` and `startCheckout`.
      action: "billing.plan_updated",
      details: { status, eventType: args.type },
    });

    /*
      THE PAYMENT IS WHAT STARTS THE BUCKET.

      Scheduled from inside the same transaction that turned the plan active,
      so there is no window where somebody has paid for managed storage and
      nothing has been asked to create it. Scheduling rather than calling: this
      runs in a mutation, and the action it starts opens the operator
      credential.

      Every precondition is re-read by the action itself — entitlement, an
      existing binding, the configuration — because a redelivered event can
      schedule this twice and a cancellation can land in between. Running it
      twice is safe by construction: the second run adopts the bucket the first
      one made.
    */
    const wantsManaged = restored?.managedStorage ?? plan.managedStorage;
    if (planIsPaying(status) && wantsManaged) {
      const bound = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", plan.workspaceId))
        .unique();
      if (bound === null) {
        await ctx.db.patch(plan._id, { managedProvisioning: "running" });
        await ctx.scheduler.runAfter(
          0,
          internal.functions.managedProvisioning.provisionManagedStorage,
          { workspaceId: plan.workspaceId },
        );
      }
    }

    return { applied: true, reason: status };
  },
});

/**
 * Which plan row this event is about, or `null`.
 *
 * Two ways in, in order of trust: our own checkout row, then a subscription id
 * we stored ourselves. There is deliberately no third — no lookup by customer
 * id, and none by anything in the event's `metadata`, because both would let a
 * field written outside this codebase choose a row.
 */
async function resolvePlan(
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

/** The shape `http.ts` hands to `applyStripeEvent`. Declared once, here. */
export type StripeEventArgs = StripeEventFacts;
