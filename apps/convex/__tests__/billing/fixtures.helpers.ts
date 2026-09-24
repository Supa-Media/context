/**
 * A PLAN BELONGS TO A CONTEXT, AND AN UNSIGNED WEBHOOK BUYS NOTHING.
 *
 * Two properties are load-bearing here and everything else in this file is
 * ordinary authorization.
 *
 * **The webhook signature is the whole security of the endpoint.** It is
 * public by construction — Stripe posts to it from an address we do not
 * control, with no bearer token — so the only thing between a stranger and a
 * free upgrade is an HMAC computed with a secret only Stripe and this
 * deployment hold. `premium.test.ts` proves the verifier; this file proves the
 * *route* uses it, because a correct verifier nobody calls is decoration.
 *
 * **The workspace is never read out of an event.** A completed checkout is
 * matched to our own `billingSessions` row through `client_reference_id`, and
 * every later event to a subscription id we stored ourselves. An identifier
 * that arrives from outside may select a row we wrote and may never name a
 * tenant — the same rule `expectedWorkspaceId` follows at the gateway.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts as measured, and recorded
 * per row rather than "the last one" — a table that is appended to is not a
 * table you can index from the end.
 *
 *   `stripeWebhookRoute` skipping the signature check entirely        3
 *   `stripeSignatureIsValid` treating an absent secret as "allow"     2
 *   `applyStripeEvent` dropping the `lastEventId` check               1
 *   `applyStripeEvent` dropping the out-of-order check                1
 *   `applyStripeEvent` resolving a workspace from event metadata      1
 *   `setEntitlements` and `startCheckout` accepting an editor         1
 *   `status` returning the money fields to every member               1
 *   `billingSession` returning a URL to another member                1
 *   `startCheckout` opening a second checkout on a second press         1
 *   `startCheckout` reusing a co-owner's live attempt                    1
 *   `status` letting a malformed price id throw at every reader          1
 *
 * Added after the adversarial review, run against a committed tree:
 *
 *   `lastEventIds` back to one remembered id                             1
 *   the ordering check widened to `<=` instead                           2
 *   the id set reset on every apply rather than when the second moves    1
 *   `setEntitlements` ignoring a live checkout                           1
 *   the checkout snapshot not restored at activation                     1
 *   the cascade deleting the plan row without cancelling                 2
 *   the cascade not sweeping the plan table at all                       3
 *   `returnUrl` falling back to an empty origin again                0 → 1
 *   a live attempt's snapshot not following a changed selection          1
 *
 * **The `returnUrl` row is 0 → 1 and the 0 is a finding about this file.** The
 * test seeded no payment key, so the action answered `NOT_CONFIGURED` for the
 * *missing key* and the assertion passed whatever `returnUrl` did —
 * reintroducing the empty fallback failed nothing at all. It seeds one now, so
 * `APP_ORIGIN` is the only thing missing and the only thing the answer can be
 * about. A test that cannot fail is not evidence, and only the sabotage pass
 * distinguishes the two.
 *
 * **The metadata row is the one worth reading twice.** It is not a line that
 * exists to be deleted — nothing here reads a workspace out of an event — so
 * the sabotage was to *write* the vulnerable version: a `workspaceHint` field
 * read off `data.object.metadata.workspaceId`, forwarded through the route,
 * and preferred by `resolvePlan`. That is the shape somebody adds when a
 * subscription event arrives with no checkout row to match, and it fails one
 * test rather than none.
 */

import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  type TestConvex,
  asUser,
  createUser,
  createWorkspace,
} from "../fixtures.helpers";
import { STRIPE_SIGNATURE_HEADER } from "../../functions/lib/stripe";

/** Obviously fake. This repository is public. */
export const SIGNING_SECRET = "whsec_obviously_fake_test_secret";
export const FAKE_PRICE_ID = "price_FAKE00000000";

export async function context(t: TestConvex, slug: string) {
  const owner = await createUser(t, `${slug}-owner@example.invalid`);
  const workspaceId = await createWorkspace(t, owner, slug);
  return { owner, workspaceId };
}

export async function chooseBoth(t: TestConvex, owner: Id<"users">, workspaceId: Id<"workspaces">) {
  await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
    workspaceId,
    managedStorage: true,
    fastSearch: true,
  });
}

/** Sign a body the way Stripe does, so the route's own check is exercised. */
export async function signed(payload: string, secret = SIGNING_SECRET): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const digest = [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${digest}`;
}

export async function postWebhook(
  t: TestConvex,
  event: unknown,
  options: { header?: string | null; secret?: string } = {},
): Promise<Response> {
  const payload = JSON.stringify(event);
  const header =
    options.header === undefined
      ? await signed(payload, options.secret ?? SIGNING_SECRET)
      : options.header;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (header !== null) headers[STRIPE_SIGNATURE_HEADER] = header;
  return await t.fetch("/stripe/webhook", { method: "POST", body: payload, headers });
}

/**
 * A `checkout.session.completed` event, built from Stripe's documented shape.
 *
 * NOTHING IN THIS FILE WAS OBSERVED FROM A LIVE STRIPE ACCOUNT: no request has
 * been made against api.stripe.com from the environment this was written in.
 */
export function checkoutCompleted(sessionId: string, over: Record<string, unknown> = {}) {
  return {
    id: "evt_fake_checkout_1",
    object: "event",
    type: "checkout.session.completed",
    created: 1_780_000_000,
    data: {
      object: {
        id: "cs_test_fake",
        object: "checkout.session",
        client_reference_id: sessionId,
        customer: "cus_FAKE",
        subscription: "sub_FAKE",
        status: "complete",
        payment_status: "paid",
        ...over,
      },
    },
  };
}

export function subscriptionEvent(over: {
  id?: string;
  type?: string;
  created?: number;
  status?: string;
  subscription?: string;
} = {}) {
  return {
    id: over.id ?? "evt_fake_sub_1",
    object: "event",
    type: over.type ?? "customer.subscription.updated",
    created: over.created ?? 1_780_000_100,
    data: {
      object: {
        id: over.subscription ?? "sub_FAKE",
        object: "subscription",
        customer: "cus_FAKE",
        status: over.status ?? "active",
        current_period_end: 1_782_000_000,
        cancel_at_period_end: false,
      },
    },
  };
}

