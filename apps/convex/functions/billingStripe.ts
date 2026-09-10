/**
 * The two calls this product makes to Stripe.
 *
 * Both are `internalAction`s reached only by a schedule edge from
 * `functions/billing.ts` — "scheduling is not calling"
 * (`docs/decisions/storage-and-credentials.md`), which is what keeps the public
 * mutation that starts them from being a path to the payment key they open.
 *
 * ## The credential
 *
 * `STRIPE_SECRET_KEY` comes from `appSecrets`, set in the staff console,
 * exactly as `SEARCH_D1_API_TOKEN` does for the search provisioner. **Its
 * absence is an ordinary state, not a crash**: a self-hoster sells nothing and
 * a deployment nobody has configured records `NOT_CONFIGURED` and stops. The
 * key is never written to a row, never returned, never logged, and never
 * reaches the client — what reaches the client is a hosted URL Stripe minted.
 *
 * ## Failure is recorded, never thrown away
 *
 * Every exit writes a result through `recordSessionResult`. An action that
 * threw would leave a row saying `pending` forever and the settings screen
 * would spin at somebody with no way to learn why. What a failure records is
 * **our** error code, never Stripe's text — a provider message can name an
 * account, a customer or a price.
 *
 * ## NOTHING HERE HAS BEEN RUN AGAINST STRIPE
 *
 * `api.stripe.com` is not reachable from the environment this was written in
 * and no test-mode key exists here. The request shapes below follow Stripe's
 * published documentation for Checkout Sessions and Billing Portal Sessions,
 * and the tests drive them against fixtures built from that documentation.
 * The live contract is unverified: field names, required parameters and error
 * shapes have not been confirmed against a real account, and the first run
 * against Stripe should be treated as the first test of this file.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { APP_ORIGIN_ENV_VAR } from "./lib/gatewayAuth";
import { STRIPE_API_KEY_SECRET, stripePriceId } from "./lib/premium";
import { StripeApiError, stripeDelete, stripePost } from "./lib/stripe";

/**
 * Our own reasons, from a closed set. The console turns each into a sentence;
 * none of them is ever a provider's text.
 */
type FailureCode = "NOT_CONFIGURED" | "STRIPE_REFUSED" | "NO_CUSTOMER" | "NO_URL";

async function fail(
  ctx: ActionCtx,
  sessionId: Id<"billingSessions">,
  errorCode: FailureCode,
): Promise<{ status: string }> {
  await ctx.runMutation(internal.functions.billing.recordSessionResult, {
    sessionId,
    errorCode,
  });
  return { status: "failed" };
}

/** Where Stripe sends somebody back to. Never a URL the client supplied. */
function returnUrl(path: string): string {
  const origin = process.env[APP_ORIGIN_ENV_VAR];
  const base = typeof origin === "string" && origin.length > 0 ? origin : "";
  return `${base}${path}`;
}

/**
 * Read the payment key, or `null` on a deployment that has none.
 *
 * `readIntegrationSecret` is the one function that opens an `appSecrets`
 * envelope, and it is an `internalAction` — so this file is decrypt-capable and
 * is therefore internal, which `__tests__/structure.test.ts` checks rather than
 * trusts.
 */
async function apiKey(ctx: ActionCtx): Promise<string | null> {
  const key = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
    name: STRIPE_API_KEY_SECRET,
  });
  return typeof key === "string" && key.length > 0 ? key : null;
}

/**
 * Mint a Checkout Session for one context.
 *
 * `client_reference_id` is the id of **our** attempt row, which is what the
 * webhook resolves the workspace from. The workspace id is not sent as the
 * reference and not read back from one: an identifier that comes home through
 * a third party may select a row we wrote, and may not name a tenant.
 *
 * `subscription_data[metadata][workspaceId]` is sent anyway, because an
 * operator reading the Stripe dashboard needs to know which context a
 * subscription is for. It is written by us and read by a person; nothing in
 * this codebase resolves anything from it.
 */
export const createCheckoutSession = internalAction({
  args: { sessionId: v.id("billingSessions") },
  handler: async (ctx, args): Promise<{ status: string }> => {
    const session = await ctx.runQuery(internal.functions.billing.sessionForAction, {
      sessionId: args.sessionId,
    });
    if (session === null) return { status: "skipped" };
    if (session.status !== "pending") return { status: "skipped" };

    let priceId: string | null;
    try {
      priceId = stripePriceId();
    } catch {
      // Set but malformed. An operator error, and it reads to the customer as
      // "this deployment cannot sell yet", which is accurate.
      return await fail(ctx, args.sessionId, "NOT_CONFIGURED");
    }
    const key = await apiKey(ctx);
    if (priceId === null || key === null) {
      return await fail(ctx, args.sessionId, "NOT_CONFIGURED");
    }

    const params: Record<string, string | number | boolean> = {
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": 1,
      client_reference_id: String(args.sessionId),
      success_url: returnUrl("/settings?settings=premium&checkout=done"),
      cancel_url: returnUrl("/settings?settings=premium"),
      "subscription_data[metadata][workspaceId]": String(session.workspaceId),
      // Selection is ours to keep, not Stripe's to price — sent so an invoice
      // is readable by a human, never read back as an entitlement.
      "subscription_data[metadata][managedStorage]": String(
        session.selected.managedStorage,
      ),
      "subscription_data[metadata][fastSearch]": String(session.selected.fastSearch),
    };
    // Reuse the customer where this context has already had one, so a second
    // subscription does not create a second customer for the same bucket.
    if (session.stripeCustomerId !== undefined) {
      params.customer = session.stripeCustomerId;
    }

    try {
      const created = await stripePost(key, "/checkout/sessions", params);
      const url = typeof created.url === "string" ? created.url : null;
      if (url === null) return await fail(ctx, args.sessionId, "NO_URL");
      await ctx.runMutation(internal.functions.billing.recordSessionResult, {
        sessionId: args.sessionId,
        url,
      });
      return { status: "ready" };
    } catch (error) {
      // The status is worth keeping in the deployment's own logs; the message
      // is not worth forwarding, and is not.
      console.error("stripe.checkout_failed", {
        status: error instanceof StripeApiError ? error.status : 0,
      });
      return await fail(ctx, args.sessionId, "STRIPE_REFUSED");
    }
  },
});

/**
 * Cancel a subscription, because the context it paid for is being deleted.
 *
 * **The one call here that is not started by somebody pressing a button.**
 * `startPortal` is the only cancellation path in the product and it is reached
 * from that context's Premium section — so deleting the context would otherwise
 * bill the customer every month with no route in the product to stop it. That
 * is a chargeback, not a loose end.
 *
 * Scheduled from `deleteWorkspaceCascade` with the subscription id **in the
 * args**, before the row carrying it is deleted, exactly as the Dropbox
 * revocation twelve lines above it is. Scheduled and not called: that mutation
 * is public and must not reach the payment key.
 *
 * ## Failure is a log line and nothing else
 *
 * There is no row left to record a status on — the point of this action is that
 * the context is going away. A throw would be retried by the scheduler against
 * a workspace that no longer exists, so a refusal is logged with its status and
 * swallowed. That is a real residual: a cancellation Stripe refused leaves a
 * live subscription nobody here can see. It is named in `billing.md` and it is
 * strictly better than the alternative, which was not trying at all.
 *
 * `invoice_now=false` and `prorate=false` are deliberate: this is somebody
 * leaving, and issuing them a final invoice on the way out would be a bill for
 * the act of deleting their own context.
 */
export const cancelSubscription = internalAction({
  args: { subscriptionId: v.string() },
  handler: async (ctx, args): Promise<{ status: string }> => {
    const key = await apiKey(ctx);
    if (key === null) {
      // A self-hoster with no payment key never had a subscription either.
      console.error("billing.cancel_not_configured");
      return { status: "skipped" };
    }
    try {
      await stripeDelete(key, `/subscriptions/${encodeURIComponent(args.subscriptionId)}`);
      return { status: "canceled" };
    } catch (error) {
      // Never the subscription id: it is not a secret, and a log line that
      // names one customer's subscription is still a log line about a customer.
      console.error("billing.cancel_failed", {
        status: error instanceof StripeApiError ? error.status : 0,
      });
      return { status: "failed" };
    }
  },
});

/**
 * Mint a Billing Portal Session.
 *
 * The portal is where the card, the invoices and the cancellation live, and
 * that is deliberate: none of them belongs in this app, and re-implementing
 * any of them would mean holding data we have no business holding.
 */
export const createPortalSession = internalAction({
  args: { sessionId: v.id("billingSessions") },
  handler: async (ctx, args): Promise<{ status: string }> => {
    const session = await ctx.runQuery(internal.functions.billing.sessionForAction, {
      sessionId: args.sessionId,
    });
    if (session === null) return { status: "skipped" };
    if (session.status !== "pending") return { status: "skipped" };
    if (session.stripeCustomerId === undefined) {
      return await fail(ctx, args.sessionId, "NO_CUSTOMER");
    }

    const key = await apiKey(ctx);
    if (key === null) return await fail(ctx, args.sessionId, "NOT_CONFIGURED");

    try {
      const created = await stripePost(key, "/billing_portal/sessions", {
        customer: session.stripeCustomerId,
        return_url: returnUrl("/settings?settings=premium"),
      });
      const url = typeof created.url === "string" ? created.url : null;
      if (url === null) return await fail(ctx, args.sessionId, "NO_URL");
      await ctx.runMutation(internal.functions.billing.recordSessionResult, {
        sessionId: args.sessionId,
        url,
      });
      return { status: "ready" };
    } catch (error) {
      console.error("stripe.portal_failed", {
        status: error instanceof StripeApiError ? error.status : 0,
      });
      return await fail(ctx, args.sessionId, "STRIPE_REFUSED");
    }
  },
});
