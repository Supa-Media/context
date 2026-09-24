import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Usage counters, what a context pays for, and checkout sessions.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts` in declaration order. Metadata only — see that
 * file's header.
 */
export const billingTables = {
  /**
   * Daily product usage, as counters.
   *
   * ## Counters, not events, and the reason is the first non-negotiable
   *
   * An event log with one row per tool call would be a second record of what
   * somebody did in their own context, held by us — and the audit trail that
   * legitimately records that already exists, in the customer's own bucket
   * under `.audit/`, where they can read and delete it. Mining that to build
   * our dashboards would quietly turn a customer-owned record into a
   * product-analytics pipeline, which is exactly the move CLAUDE.md's first
   * rule forbids.
   *
   * So this table holds **integers per day per metric**, incremented in place.
   * There is no path column, no query text, no note title, no timestamp finer
   * than the day, and no shape into which any of those could later be added
   * without an obvious schema change and a conversation.
   *
   * `workspaceId` is optional and present only for metrics that are counted
   * per context (tool calls). Where it is set, the row says "this workspace
   * made N calls on this day" — which is metadata we already hold, of the same
   * kind as a member list, and never what the calls were about.
   */
  usageDaily: defineTable({
    /** `YYYY-MM-DD`, UTC. The bucket, and half the identity of the row. */
    day: v.string(),
    /** A `UsageMetric` from `lib/usage.ts` — a closed set, never free text. */
    metric: v.string(),
    /** Set only for per-context metrics; absent for platform-wide ones. */
    workspaceId: v.optional(v.id("workspaces")),
    count: v.number(),
    updatedAt: v.number(),
  })
    .index("by_day_metric", ["day", "metric"])
    .index("by_day_metric_workspace", ["day", "metric", "workspaceId"])
    .index("by_metric_day", ["metric", "day"]),

  /**
   * One row per workspace per day that did anything, so "active" is countable.
   *
   * Kept apart from `usageDaily` because an active-user count is a
   * **cardinality**, not a sum: incrementing a counter per call answers "how
   * many calls", and no arithmetic over that answers "how many distinct
   * contexts". The alternative — reading every counter row for a day and
   * counting the distinct workspaces — is the same data, so this table exists
   * only to make the common query a cheap range read rather than a scan.
   *
   * Rows carry no activity detail. That a context was active on a day is the
   * entire content.
   */
  usageActiveDaily: defineTable({
    day: v.string(),
    workspaceId: v.id("workspaces"),
    /** Which surface saw it — `UsageSurface` from `lib/usage.ts`. */
    surface: v.string(),
    at: v.number(),
  })
    .index("by_day", ["day"])
    .index("by_day_surface", ["day", "surface"])
    .index("by_day_surface_workspace", ["day", "surface", "workspaceId"]),

  /**
   * What one context pays for.
   *
   * **Keyed by `workspaceId`, never by `userId`**, exactly as a storage
   * binding is and for the same reason (`CLAUDE.md`, "The workspace model"):
   * you are upgrading a bucket, not a person. One person may hold a free
   * personal workspace and a paid work workspace on a work card, and each is one
   * row and one subscription. A `userId` here would make the second of those
   * impossible to express and the first impossible to keep free.
   *
   * **A row exists only where somebody chose something.** No row is the
   * ordinary state and means free, no entitlements, no Stripe customer — so
   * "how many contexts are paying" is a count rather than a filter, the same
   * shape `searchIndexes` uses.
   *
   * **Nothing here gates the exit.** There is no export flag, no quota and no
   * expiry attached to one: downloading everything, or handing the bucket to
   * storage of their own, is free, identical on both plans, and works after a
   * cancellation (non-negotiable #1). `__tests__/premium.test.ts` fails on a
   * field shaped like one.
   */
  workspacePlans: defineTable({
    workspaceId: v.id("workspaces"),
    /**
     * What the owner asked for, stored whether or not anybody is paying.
     *
     * Kept apart from what is *active* so a lapsed subscription can be resumed
     * with a payment rather than a re-selection — the same "asked for" /
     * "entitled" separation `lib/fastSearch.ts` argues at length. Nothing reads
     * these two directly to decide what a context gets: `activeEntitlements`
     * in `lib/premium.ts` is the one place that ANDs them with the status.
     */
    managedStorage: v.boolean(),
    fastSearch: v.boolean(),
    /**
     * Stripe's subscription status as this build understands it —
     * `planStatusFromStripe`, a closed set. A word we have never heard of
     * lands here as `unknown` and serves nothing; it is never read as
     * `active`, which would be an entitlement bought by a vocabulary change.
     */
    status: v.union(
      v.literal("none"),
      v.literal("active"),
      v.literal("past_due"),
      v.literal("canceled"),
      v.literal("unknown"),
    ),
    /**
     * Stripe's own identifiers, and deliberately **not credentials**: a
     * customer id and a subscription id decide nothing without the API key,
     * which lives in `appSecrets` and never here. They are what lets a later
     * event be reconciled to the context it belongs to without trusting an id
     * that arrived in the event body.
     */
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    /** Seconds, from Stripe. The end of the period already paid for. */
    currentPeriodEnd: v.optional(v.number()),
    /** True where Stripe says the subscription stops at the period end. */
    cancelAtPeriodEnd: v.optional(v.boolean()),
    /**
     * When Stripe created the newest event applied, in seconds, and **every**
     * event id applied at that second.
     *
     * Webhook delivery is at-least-once and out of order, and the two fields
     * answer the two halves of that: the timestamp drops anything created
     * before the newest applied, and the set drops a redelivery of anything
     * applied *at* it.
     *
     * ## Why a set and not one id
     *
     * One id plus a strict `<` left a hole precisely where Stripe stamps a
     * cancellation pair, because `updated` and `deleted` are emitted together
     * in the same second:
     *
     *   evt_upd (T, active)  applied → last id = evt_upd
     *   evt_del (T, deleted) applied → last id = evt_del, plan canceled
     *   evt_upd (T) retried  → a different id, and T < T is false → APPLIED,
     *                          and the cancelled plan is active again.
     *
     * A retry is freshly signed, so the signature's five-minute tolerance does
     * not bound it — it can arrive days later, anywhere in Stripe's retry
     * schedule. Widening the comparison to `<=` is not the fix either: it
     * drops the legitimate `deleted` when `updated` arrives first in the same
     * second, which is the ordinary ordering.
     *
     * So the set holds every id at `lastEventAt` and is **reset when the
     * second moves**, which is what keeps it bounded: its size is the number
     * of events Stripe emits for one subscription within one second.
     */
    lastEventIds: v.optional(v.array(v.string())),
    lastEventAt: v.optional(v.number()),
    /**
     * Where provisioning the managed bucket has got to, for the one context
     * this plan is for.
     *
     * On the plan rather than on the binding, because until it succeeds there
     * *is* no binding — and the screen that has to say "creating your storage"
     * is looking at somebody who has paid and has nothing yet. Absent is the
     * ordinary state: a context that never bought managed storage has no
     * answer here and needs none.
     *
     * `failed` is the state that has to exist. Without it the console can only
     * wait, and a person who paid two minutes ago cannot tell a slow webhook
     * from a bucket that will never appear.
     */
    managedProvisioning: v.optional(
      v.union(v.literal("running"), v.literal("ready"), v.literal("failed")),
    ),
    /**
     * Why it failed, from **our** closed set — never Cloudflare's text, which
     * can name an account. The console maps it to a sentence and a next step.
     */
    managedProvisioningError: v.optional(v.string()),
    /** When the last attempt ended, so a retry can be rate-limited by a human. */
    managedProvisioningAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    /** How a subscription event finds the context it belongs to. */
    .index("by_subscription", ["stripeSubscriptionId"]),

  /**
   * One attempt to open Stripe's hosted checkout or customer portal.
   *
   * The row exists because the URL cannot be returned from the mutation that
   * asks for it. Minting one needs the payment key, only an action may open a
   * credential, and a public action that awaited one would be a public
   * function reaching a decrypt — which `__tests__/structure.test.ts` refuses.
   * So the mutation writes a row and **schedules** the action ("scheduling is
   * not calling"), the action fills the row in, and the console watches the
   * row it was handed. Same shape as `cloudflareProvisioning`.
   *
   * The row holds a URL and no credential. Stripe's checkout URL is a
   * capability — anybody holding it can pay — so it is readable only by the
   * owner who started the attempt, and it expires.
   */
  billingSessions: defineTable({
    workspaceId: v.id("workspaces"),
    startedBy: v.id("users"),
    kind: v.union(v.literal("checkout"), v.literal("portal")),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    /** Stripe's hosted page, once it exists. */
    url: v.optional(v.string()),
    /**
     * What the owner had chosen when this attempt was opened.
     *
     * **What somebody paid for is what they chose at checkout**, not whatever
     * the toggles happen to say when the webhook lands minutes later. Stored
     * so a plan can never activate entitling nothing: if the live selection is
     * empty at activation, this is restored. Absent on a portal attempt, which
     * buys nothing.
     */
    selectedAtCheckout: v.optional(
      v.object({ managedStorage: v.boolean(), fastSearch: v.boolean() }),
    ),
    /**
     * Where the attempt started, which decides where finishing returns to.
     *
     * Optional because rows written before this existed have no answer, and
     * "settings" is the right reading of those: it is where the only checkout
     * the product had could be started from. Never taken from a client as a
     * URL — it selects one of two shapes we wrote, which is the same rule
     * `expectedWorkspaceId` follows at the gateway.
     */
    origin: v.optional(v.union(v.literal("settings"), v.literal("onboarding"))),
    /** Ours, from a closed set — never Stripe's text, which can name an account. */
    errorCode: v.optional(v.string()),
    /**
     * Short. An attempt nobody completed within a few minutes is a tab
     * somebody abandoned, and a live checkout URL is a live capability.
     */
    expiresAt: v.number(),
    /**
     * Where provisioning the managed bucket has got to, for the one context
     * this plan is for.
     *
     * On the plan rather than on the binding, because until it succeeds there
     * *is* no binding — and the screen that has to say "creating your storage"
     * is looking at somebody who has paid and has nothing yet. Absent is the
     * ordinary state: a context that never bought managed storage has no
     * answer here and needs none.
     *
     * `failed` is the state that has to exist. Without it the console can only
     * wait, and a person who paid two minutes ago cannot tell a slow webhook
     * from a bucket that will never appear.
     */
    managedProvisioning: v.optional(
      v.union(v.literal("running"), v.literal("ready"), v.literal("failed")),
    ),
    /**
     * Why it failed, from **our** closed set — never Cloudflare's text, which
     * can name an account. The console maps it to a sentence and a next step.
     */
    managedProvisioningError: v.optional(v.string()),
    /** When the last attempt ended, so a retry can be rate-limited by a human. */
    managedProvisioningAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_expiresAt", ["expiresAt"]),
};
