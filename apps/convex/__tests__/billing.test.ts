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

import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  seedAppSecret,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { MANAGED_R2_ACCOUNT_ID_ENV_VAR } from "../functions/lib/managedStorage";
import {
  STRIPE_API_KEY_SECRET,
  STRIPE_PRICE_ID_ENV_VAR,
} from "../functions/lib/premium";
import { STRIPE_SIGNATURE_HEADER } from "../functions/lib/stripe";

/** Obviously fake. This repository is public. */
const SIGNING_SECRET = "whsec_obviously_fake_test_secret";
const FAKE_PRICE_ID = "price_FAKE00000000";

async function context(t: TestConvex, slug: string) {
  const owner = await createUser(t, `${slug}-owner@example.invalid`);
  const workspaceId = await createWorkspace(t, owner, slug);
  return { owner, workspaceId };
}

async function chooseBoth(t: TestConvex, owner: Id<"users">, workspaceId: Id<"workspaces">) {
  await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
    workspaceId,
    managedStorage: true,
    fastSearch: true,
  });
}

/** Sign a body the way Stripe does, so the route's own check is exercised. */
async function signed(payload: string, secret = SIGNING_SECRET): Promise<string> {
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

async function postWebhook(
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
function checkoutCompleted(sessionId: string, over: Record<string, unknown> = {}) {
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

function subscriptionEvent(over: {
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

describe("choosing what a context pays for", () => {
  test("a context nobody chose anything for has no row at all", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "untouched");
    const rows = await t.run((ctx) => ctx.db.query("workspacePlans").collect());
    expect(rows).toHaveLength(0);

    const view = await asUser(t, owner).query(api.functions.billing.status, {
      workspaceId,
    });
    expect(view.status).toBe("none");
    expect(view.selected).toEqual({ managedStorage: false, fastSearch: false });
    expect(view.active).toEqual({ managedStorage: false, fastSearch: false });
  });

  test("the two are independent and the price does not move", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "alacarte");
    await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
      workspaceId,
      managedStorage: true,
      fastSearch: false,
    });
    const storageOnly = await asUser(t, owner).query(api.functions.billing.status, {
      workspaceId,
    });
    expect(storageOnly.selected).toEqual({ managedStorage: true, fastSearch: false });

    await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
      workspaceId,
      managedStorage: false,
      fastSearch: true,
    });
    const searchOnly = await asUser(t, owner).query(api.functions.billing.status, {
      workspaceId,
    });
    expect(searchOnly.selected).toEqual({ managedStorage: false, fastSearch: true });
    expect(searchOnly.priceCents).toBe(storageOnly.priceCents);
  });

  test("an editor may write every note and may not commit a card", async () => {
    // Write access to somebody's notes is not authority over their money —
    // the same argument `fastSearch.enable` makes about a derived copy.
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "editorless");
    const editor = await createUser(t, "editor@example.invalid");
    await addMember(t, workspaceId, editor, "editor", owner);

    await expect(
      asUser(t, editor).mutation(api.functions.billing.setEntitlements, {
        workspaceId,
        managedStorage: true,
        fastSearch: false,
      }),
    ).rejects.toThrow();
    await expect(
      asUser(t, editor).mutation(api.functions.billing.startCheckout, { workspaceId }),
    ).rejects.toThrow();
    await expect(
      asUser(t, editor).mutation(api.functions.billing.startPortal, { workspaceId }),
    ).rejects.toThrow();
  });

  test("a stranger cannot even learn the context exists", async () => {
    const t = setupTest();
    const { workspaceId } = await context(t, "isolated");
    const stranger = await createUser(t, "stranger@example.invalid");
    await expect(
      asUser(t, stranger).query(api.functions.billing.status, { workspaceId }),
    ).rejects.toThrow(/WORKSPACE_NOT_FOUND|Workspace not found/);
  });

  test("choosing neither is refused while a subscription is live", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "neither");
    await chooseBoth(t, owner, workspaceId);
    await t.run(async (ctx) => {
      const plan = await ctx.db.query("workspacePlans").unique();
      await ctx.db.patch(plan!._id, { status: "active" });
    });

    await expect(
      asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
        workspaceId,
        managedStorage: false,
        fastSearch: false,
      }),
    ).rejects.toThrow(/at least one/i);
  });

  test("nor while a checkout is in flight, which is where the gap was", async () => {
    /*
      The refusal used to read `planIsPaying`, and between pressing Upgrade and
      the webhook landing the status is still `none` — so emptying both boxes
      was allowed, and the plan then activated entitling nothing. $20 a month
      for zero. Reviewer reproduced it as `active {fastSearch:false,
      managedStorage:false}`.
    */
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "inflight");
    await chooseBoth(t, owner, workspaceId);
    await asUser(t, owner).mutation(api.functions.billing.startCheckout, {
      workspaceId,
    });
    await expect(
      asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
        workspaceId,
        managedStorage: false,
        fastSearch: false,
      }),
    ).rejects.toThrow(/at least one/i);
  });

  test("but is allowed on a context nobody is paying for", async () => {
    // Undoing a choice before you have paid for it is not a cancellation.
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "undo");
    await chooseBoth(t, owner, workspaceId);
    await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
      workspaceId,
      managedStorage: false,
      fastSearch: false,
    });
    const view = await asUser(t, owner).query(api.functions.billing.status, {
      workspaceId,
    });
    expect(view.selected).toEqual({ managedStorage: false, fastSearch: false });
  });

  test("the choice is audited", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "audited-plan");
    await chooseBoth(t, owner, workspaceId);
    const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audit.map((row) => row.action)).toContain("billing.entitlements_set");
  });
});

describe("what a member may see, and what only an owner may", () => {
  test("a member knows the plan and not the money", async () => {
    // Same gate, same reasoning, as `fastSearch.status`'s backfill counters: a
    // member may read only the `team` tier, so a total that includes private
    // notes lets them derive how much they are not being shown.
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "membered");
    const member = await createUser(t, "member@example.invalid");
    await addMember(t, workspaceId, member, "member", owner);
    await chooseBoth(t, owner, workspaceId);
    await t.run(async (ctx) => {
      const plan = await ctx.db.query("workspacePlans").unique();
      await ctx.db.patch(plan!._id, {
        status: "active",
        stripeCustomerId: "cus_FAKE",
        currentPeriodEnd: 1_782_000_000,
      });
    });

    const seen = await asUser(t, member).query(api.functions.billing.status, {
      workspaceId,
    });
    expect(seen.status).toBe("active");
    expect(seen.active).toEqual({ managedStorage: true, fastSearch: true });
    expect(seen.canManage).toBe(false);
    expect(seen.currentPeriodEnd).toBeUndefined();
    expect(seen.hasStripeCustomer).toBeUndefined();
    expect(seen.notes).toBeUndefined();
    // The id itself is never returned to anybody, owner included.
    expect(JSON.stringify(seen)).not.toContain("cus_FAKE");

    const byOwner = await asUser(t, owner).query(api.functions.billing.status, {
      workspaceId,
    });
    expect(byOwner.canManage).toBe(true);
    expect(byOwner.currentPeriodEnd).toBe(1_782_000_000);
    expect(byOwner.hasStripeCustomer).toBe(true);
    expect(JSON.stringify(byOwner)).not.toContain("cus_FAKE");
  });
});

describe("asking for a checkout URL", () => {
  test("the mutation hands back a row, and the URL never comes from the client", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "checkout");
    await chooseBoth(t, owner, workspaceId);
    const { sessionId } = await asUser(t, owner).mutation(
      api.functions.billing.startCheckout,
      { workspaceId },
    );
    const row = await asUser(t, owner).query(api.functions.billing.billingSession, {
      sessionId,
    });
    expect(row?.status).toBe("pending");
    expect(row?.url).toBeUndefined();
  });

  test("a checkout URL goes back to the browser that asked and nowhere else", async () => {
    // It is a capability: anybody holding it can put a card against this
    // context. So it is scoped to the person who started the attempt, not to
    // the workspace — a second owner does not inherit somebody's payment page.
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "capability");
    const second = await createUser(t, "second-owner@example.invalid");
    await addMember(t, workspaceId, second, "owner", owner);
    await chooseBoth(t, owner, workspaceId);
    const { sessionId } = await asUser(t, owner).mutation(
      api.functions.billing.startCheckout,
      { workspaceId },
    );
    await t.run((ctx) =>
      ctx.db.patch(sessionId, { status: "ready", url: "https://checkout.invalid/x" }),
    );

    expect(
      await asUser(t, second).query(api.functions.billing.billingSession, { sessionId }),
    ).toBeNull();
    expect(
      (await asUser(t, owner).query(api.functions.billing.billingSession, { sessionId }))
        ?.url,
    ).toBe("https://checkout.invalid/x");
  });

  test("pressing Upgrade twice does not open two checkouts", async () => {
    /*
      Two Checkout Sessions for one bucket, and a person who pays on both has
      two subscriptions of which this control plane knows about one — the other
      goes on being charged with nothing here naming it. Stripe cannot dedupe
      that: two sessions built from the same parameters are two legitimate
      intents as far as it is concerned.
    */
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "double-press");
    await chooseBoth(t, owner, workspaceId);
    const first = await asUser(t, owner).mutation(
      api.functions.billing.startCheckout,
      { workspaceId },
    );
    const second = await asUser(t, owner).mutation(
      api.functions.billing.startCheckout,
      { workspaceId },
    );
    expect(second.sessionId).toBe(first.sessionId);
    const rows = await t.run((ctx) => ctx.db.query("billingSessions").collect());
    expect(rows).toHaveLength(1);
  });

  test("but a stale one does not block a new attempt", async () => {
    // A tab abandoned yesterday must not be the reason somebody cannot pay
    // today.
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "stale-press");
    await chooseBoth(t, owner, workspaceId);
    const first = await asUser(t, owner).mutation(
      api.functions.billing.startCheckout,
      { workspaceId },
    );
    await t.run((ctx) => ctx.db.patch(first.sessionId, { expiresAt: Date.now() - 1 }));
    const second = await asUser(t, owner).mutation(
      api.functions.billing.startCheckout,
      { workspaceId },
    );
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  test("nor does one that failed", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "failed-press");
    await chooseBoth(t, owner, workspaceId);
    const first = await asUser(t, owner).mutation(
      api.functions.billing.startCheckout,
      { workspaceId },
    );
    await t.action(internal.functions.billingStripe.createCheckoutSession, {
      sessionId: first.sessionId,
    });
    const second = await asUser(t, owner).mutation(
      api.functions.billing.startCheckout,
      { workspaceId },
    );
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  test("and another owner's attempt is not handed to this one", async () => {
    // A checkout URL is a capability. Reusing a co-owner's live attempt would
    // hand it to somebody it was never minted for.
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "two-owners-press");
    const second = await createUser(t, "second@example.invalid");
    await addMember(t, workspaceId, second, "owner", owner);
    await chooseBoth(t, owner, workspaceId);
    const mine = await asUser(t, owner).mutation(api.functions.billing.startCheckout, {
      workspaceId,
    });
    const theirs = await asUser(t, second).mutation(
      api.functions.billing.startCheckout,
      { workspaceId },
    );
    expect(theirs.sessionId).not.toBe(mine.sessionId);
  });

  test("an expired attempt hands back no URL", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "expired");
    await chooseBoth(t, owner, workspaceId);
    const { sessionId } = await asUser(t, owner).mutation(
      api.functions.billing.startCheckout,
      { workspaceId },
    );
    await t.run((ctx) =>
      ctx.db.patch(sessionId, {
        status: "ready",
        url: "https://checkout.invalid/x",
        expiresAt: Date.now() - 1,
      }),
    );
    const row = await asUser(t, owner).query(api.functions.billing.billingSession, {
      sessionId,
    });
    expect(row?.url).toBeUndefined();
  });

  test("nothing is bought without choosing something first", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "empty-cart");
    await expect(
      asUser(t, owner).mutation(api.functions.billing.startCheckout, { workspaceId }),
    ).rejects.toThrow(/managed storage|fast search/i);
  });

  test("a deployment with no price id records a reason rather than spinning", async () => {
    // A self-hoster sells nothing. The row must say so; a `pending` row nobody
    // resolves is a spinner with no end.
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "unconfigured");
    await chooseBoth(t, owner, workspaceId);
    const { sessionId } = await asUser(t, owner).mutation(
      api.functions.billing.startCheckout,
      { workspaceId },
    );
    await t.action(internal.functions.billingStripe.createCheckoutSession, {
      sessionId,
    });
    const row = await asUser(t, owner).query(api.functions.billing.billingSession, {
      sessionId,
    });
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("NOT_CONFIGURED");
  });

  test("a malformed price id does not take the section down for everybody", async () => {
    /*
      `stripePriceId` throws on a value that is present and malformed, which is
      right where it is *read* — the minting action turns it into a recorded
      `NOT_CONFIGURED`. In a public query it would be an operator typo in one
      environment variable throwing for every member of every context on this
      deployment, on a read that changes nothing.
    */
    const t = setupTest();
    vi.stubEnv(STRIPE_PRICE_ID_ENV_VAR, "not-a-price-id");
    try {
      const { owner, workspaceId } = await context(t, "typo");
      const view = await asUser(t, owner).query(api.functions.billing.status, {
        workspaceId,
      });
      expect(view.configured).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a price id without a payment key is still not configured", async () => {
    const t = setupTest();
    vi.stubEnv(STRIPE_PRICE_ID_ENV_VAR, FAKE_PRICE_ID);
    try {
      const { owner, workspaceId } = await context(t, "halfconfigured");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await t.action(internal.functions.billingStripe.createCheckoutSession, {
        sessionId,
      });
      const row = await asUser(t, owner).query(api.functions.billing.billingSession, {
        sessionId,
      });
      expect(row?.status).toBe("failed");
      expect(row?.errorCode).toBe("NOT_CONFIGURED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a deployment with no APP_ORIGIN says so, rather than blaming Stripe", async () => {
    /*
      `returnUrl` used to fall back to `""`, producing a relative `success_url`
      that Stripe requires to be absolute. A self-hoster mid-setup got
      `STRIPE_REFUSED` — "that did not go through, check your connection" — for
      a configuration they had simply not finished. Everywhere else an absent
      `APP_ORIGIN` is loud; this was the one place it was papered over, and the
      paper said the wrong thing.
    */
    /*
      A PAYMENT KEY IS SEEDED, and that is the whole point of this setup.

      Without one the action answers `NOT_CONFIGURED` for the *missing key*, so
      the assertion below passes whatever `returnUrl` does — which is how it was
      written first, and the sabotage pass caught it: reintroducing the empty
      fallback failed nothing. Everything else this deployment needs is present
      here, so `APP_ORIGIN` is the only thing missing and the only thing the
      answer can be about.
    */
    const t = setupTest();
    await seedAppSecret(t, STRIPE_API_KEY_SECRET, "sk_test_obviously_fake_key");
    vi.stubEnv(STRIPE_PRICE_ID_ENV_VAR, FAKE_PRICE_ID);
    vi.stubEnv("APP_ORIGIN", "");
    try {
      const { owner, workspaceId } = await context(t, "no-origin");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await t.action(internal.functions.billingStripe.createCheckoutSession, {
        sessionId,
      });
      const row = await asUser(t, owner).query(api.functions.billing.billingSession, {
        sessionId,
      });
      expect(row?.errorCode).toBe("NOT_CONFIGURED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the portal is not offered before there is a customer to manage", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "noportal");
    await chooseBoth(t, owner, workspaceId);
    await expect(
      asUser(t, owner).mutation(api.functions.billing.startPortal, { workspaceId }),
    ).rejects.toThrow(/nothing to manage/i);
  });
});

describe("the webhook", () => {
  test("an unsigned delivery buys nothing", async () => {
    // THE TEST THIS FILE EXISTS FOR. An unsigned webhook that sets an
    // entitlement is a free upgrade for anybody who can POST.
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "unsigned");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );

      for (const header of [null, "", "garbage", `t=1,v1=${"a".repeat(64)}`]) {
        const response = await postWebhook(t, checkoutCompleted(sessionId), {
          header,
        });
        expect(response.status).toBe(401);
      }
      const plan = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
      expect(plan?.status).toBe("none");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a delivery signed with somebody else's secret buys nothing either", async () => {
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "wrongsecret");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      const response = await postWebhook(t, checkoutCompleted(sessionId), {
        secret: "whsec_a_different_fake_secret",
      });
      expect(response.status).toBe(401);
      const plan = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
      expect(plan?.status).toBe("none");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a deployment with no signing secret refuses every delivery", async () => {
    // Not "allows". `vitest.config.ts` sets no signing secret, so this is the
    // default state of the whole suite and of a self-hoster's deployment.
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "nosecret");
    await chooseBoth(t, owner, workspaceId);
    const { sessionId } = await asUser(t, owner).mutation(
      api.functions.billing.startCheckout,
      { workspaceId },
    );
    const response = await postWebhook(t, checkoutCompleted(sessionId));
    expect(response.status).toBe(401);
  });

  test("a signed completed checkout turns the plan on", async () => {
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "upgrade");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      const response = await postWebhook(t, checkoutCompleted(sessionId));
      expect(response.status).toBe(200);

      const view = await asUser(t, owner).query(api.functions.billing.status, {
        workspaceId,
      });
      expect(view.status).toBe("active");
      expect(view.active).toEqual({ managedStorage: true, fastSearch: true });
      expect(view.hasStripeCustomer).toBe(true);
      const scheduled = await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      expect(
        scheduled.filter((job) => job.name.includes("syncPremiumSelection")),
      ).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the workspace comes off our row, never out of the event", async () => {
    /*
      The event carries `metadata.workspaceId` for an operator reading the
      Stripe dashboard. If anything here resolved from it, a signed event
      naming another tenant's workspace would upgrade that tenant — and during
      a signing-secret leak that is a cross-tenant write. So the reference is
      OUR session row, and a bogus one resolves to nothing.
    */
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const victim = await context(t, "victim");
      await chooseBoth(t, victim.owner, victim.workspaceId);
      const attacker = await context(t, "attacker");
      await chooseBoth(t, attacker.owner, attacker.workspaceId);
      const { sessionId } = await asUser(t, attacker.owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId: attacker.workspaceId },
      );

      // The attacker's own session, with the victim's workspace named all over
      // the metadata. Only the attacker's context may move.
      const event = checkoutCompleted(sessionId, {
        metadata: { workspaceId: victim.workspaceId },
      });
      (event.data.object as Record<string, unknown>).workspaceId = victim.workspaceId;
      expect((await postWebhook(t, event)).status).toBe(200);

      const victimView = await asUser(t, victim.owner).query(
        api.functions.billing.status,
        { workspaceId: victim.workspaceId },
      );
      expect(victimView.status).toBe("none");
      const attackerView = await asUser(t, attacker.owner).query(
        api.functions.billing.status,
        { workspaceId: attacker.workspaceId },
      );
      expect(attackerView.status).toBe("active");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a reference to no row of ours changes nothing, and is not retried", async () => {
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "noref");
      await chooseBoth(t, owner, workspaceId);
      // 200, deliberately: a non-2xx tells Stripe to retry, and retrying will
      // not make this row exist.
      const response = await postWebhook(t, checkoutCompleted("not-an-id"));
      expect(response.status).toBe(200);
      const view = await asUser(t, owner).query(api.functions.billing.status, {
        workspaceId,
      });
      expect(view.status).toBe("none");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a redelivery of the same event is a no-op", async () => {
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "redelivered");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await postWebhook(t, checkoutCompleted(sessionId));
      const first = await t.run((ctx) => ctx.db.query("workspacePlans").unique());

      await postWebhook(t, checkoutCompleted(sessionId));
      const second = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
      /*
        What "no-op" means here, stated as the fields the event writes rather
        than as `updatedAt`.

        It was `updatedAt`, which was a fair proxy while this event was the
        only thing that ever touched the row — and stopped being one when a
        paid plan started scheduling its own bucket, because recording where
        *that* got to is a legitimate later write to the same row. Asserting
        the applied event's own fields is both narrower and stronger: a second
        application would move the status, the event id and the audit trail,
        and none of them moves.
      */
      expect(second!.status).toBe(first!.status);
      expect(second!.lastEventIds).toEqual(first!.lastEventIds);
      expect(second!.lastEventAt).toBe(first!.lastEventAt);
      expect(second!.stripeSubscriptionId).toBe(first!.stripeSubscriptionId);
      // And no second audit row claiming the plan changed twice.
      const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
      expect(audit.filter((row) => row.action === "billing.plan_updated")).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("an older event arriving after a newer one does not undo it", async () => {
    /*
      Delivery is at-least-once and out of order. Without the timestamp check,
      a retried `subscription.updated` from before a cancellation quietly
      re-activates a cancelled plan — which is the failure that is invisible
      until somebody notices they are still being served after cancelling.
    */
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "outoforder");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await postWebhook(t, checkoutCompleted(sessionId));

      await postWebhook(
        t,
        subscriptionEvent({
          id: "evt_cancel",
          type: "customer.subscription.deleted",
          created: 1_780_000_500,
          status: "canceled",
        }),
      );
      expect(
        (await asUser(t, owner).query(api.functions.billing.status, { workspaceId }))
          .status,
      ).toBe("canceled");

      // The stale retry, created before the cancellation.
      await postWebhook(
        t,
        subscriptionEvent({
          id: "evt_stale",
          created: 1_780_000_200,
          status: "active",
        }),
      );
      const after = await asUser(t, owner).query(api.functions.billing.status, {
        workspaceId,
      });
      expect(after.status).toBe("canceled");
      expect(after.active).toEqual({ managedStorage: false, fastSearch: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a cancellation is not undone by a retry stamped in the same second", async () => {
    /*
      THE ONE THE STRICT COMPARISON LET THROUGH.

      Two decisions cancelled each other out at a second boundary — which is
      exactly where Stripe stamps a cancellation pair, because `updated` and
      `deleted` are emitted together. `lastEventId` remembered ONE id, and the
      ordering check was strict `<`, so an event created in the same second as
      the last one applied was neither a duplicate nor out of order:

        evt_upd (T, active)  → applied.  lastEventId = evt_upd
        evt_del (T, deleted) → applied.  lastEventId = evt_del, plan canceled
        evt_upd (T) retried  → id differs, and T < T is false → APPLIED
                             → plan active again, both entitlements restored.

      Delivery is at-least-once and a retry is freshly signed, so the
      signature's five-minute tolerance does not bound this: it can arrive at
      any point in Stripe's retry schedule, days later, and it re-activates a
      subscription somebody cancelled.

      `<=` is not the fix — it drops the legitimate `deleted` when `updated`
      arrives first in the same second, which is the ordinary ordering. The fix
      is to remember every id applied *at* `lastEventAt`.
    */
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "resurrection");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await postWebhook(t, checkoutCompleted(sessionId));

      // The pair Stripe emits together, both stamped in the same second.
      const sameSecond = 1_780_000_500;
      await postWebhook(
        t,
        subscriptionEvent({ id: "evt_upd", created: sameSecond, status: "active" }),
      );
      await postWebhook(
        t,
        subscriptionEvent({
          id: "evt_del",
          type: "customer.subscription.deleted",
          created: sameSecond,
          status: "canceled",
        }),
      );
      expect(
        (await asUser(t, owner).query(api.functions.billing.status, { workspaceId }))
          .status,
      ).toBe("canceled");

      // Stripe retries the earlier one. It must change nothing.
      await postWebhook(
        t,
        subscriptionEvent({ id: "evt_upd", created: sameSecond, status: "active" }),
      );
      const after = await asUser(t, owner).query(api.functions.billing.status, {
        workspaceId,
      });
      expect(after.status).toBe("canceled");
      expect(after.active).toEqual({ managedStorage: false, fastSearch: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("...and the legitimate second half of that pair is still applied", async () => {
    /*
      The direction `<=` would have broken, and the reason the fix is a set of
      ids rather than a wider comparison. `updated` then `deleted` in one second
      is the ORDINARY ordering, and the cancellation must land.
    */
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "same-second-pair");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await postWebhook(t, checkoutCompleted(sessionId));

      const sameSecond = 1_780_000_500;
      await postWebhook(
        t,
        subscriptionEvent({ id: "evt_a", created: sameSecond, status: "active" }),
      );
      await postWebhook(
        t,
        subscriptionEvent({
          id: "evt_b",
          type: "customer.subscription.deleted",
          created: sameSecond,
          status: "canceled",
        }),
      );
      expect(
        (await asUser(t, owner).query(api.functions.billing.status, { workspaceId }))
          .status,
      ).toBe("canceled");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a retry from an older second is still dropped, and does not clear the set", async () => {
    // The half that already worked, kept: remembering ids *at* `lastEventAt`
    // must not weaken the ordering check that covers everything before it.
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "older-second");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await postWebhook(t, checkoutCompleted(sessionId));
      await postWebhook(
        t,
        subscriptionEvent({
          id: "evt_cancel",
          type: "customer.subscription.deleted",
          created: 1_780_000_900,
          status: "canceled",
        }),
      );
      await postWebhook(
        t,
        subscriptionEvent({ id: "evt_old", created: 1_780_000_200, status: "active" }),
      );
      expect(
        (await asUser(t, owner).query(api.functions.billing.status, { workspaceId }))
          .status,
      ).toBe("canceled");
      // …and a retry of the id that IS at the current second is still caught,
      // which is what a naive "reset the set on every apply" would break.
      await postWebhook(
        t,
        subscriptionEvent({
          id: "evt_cancel",
          type: "customer.subscription.deleted",
          created: 1_780_000_900,
          status: "canceled",
        }),
      );
      const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
      expect(
        audit.filter((row) => row.action === "billing.plan_updated"),
      ).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a lapse loses the entitlements and keeps the choice", async () => {
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "lapsed");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await postWebhook(t, checkoutCompleted(sessionId));
      await postWebhook(
        t,
        subscriptionEvent({ id: "evt_pastdue", created: 1_780_001_000, status: "past_due" }),
      );

      const view = await asUser(t, owner).query(api.functions.billing.status, {
        workspaceId,
      });
      expect(view.status).toBe("past_due");
      expect(view.active).toEqual({ managedStorage: false, fastSearch: false });
      // Resuming is a payment, not a re-selection.
      expect(view.selected).toEqual({ managedStorage: true, fastSearch: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a plan never activates entitling nothing, even if the selection was emptied", async () => {
    /*
      The belt to the refusal's braces, for the race the refusal cannot catch —
      two tabs, or a mutation landing between the press and the webhook. What a
      person paid for is what they chose **at checkout**, so that selection is
      snapshotted on the attempt row and restored if the live one is empty when
      the plan activates. Nobody ends up paying $20 for nothing.
    */
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "emptied-mid-flight");
      await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
        workspaceId,
        managedStorage: true,
        fastSearch: false,
      });
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      // Straight to the row, because the mutation now refuses this — the point
      // is that the webhook is safe even if the state is reached some other way.
      await t.run(async (ctx) => {
        const plan = await ctx.db.query("workspacePlans").unique();
        await ctx.db.patch(plan!._id, { managedStorage: false, fastSearch: false });
      });

      await postWebhook(t, checkoutCompleted(sessionId));
      const view = await asUser(t, owner).query(api.functions.billing.status, {
        workspaceId,
      });
      expect(view.status).toBe("active");
      expect(view.active).toEqual({ managedStorage: true, fastSearch: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the snapshot follows the choice while the attempt is live", async () => {
    /*
      Found reading my own fix rather than by the review.

      A live attempt is reused rather than joined by a second one, so the
      snapshot was whatever had been chosen at the FIRST press. Change the
      selection afterwards — allowed, as long as it is not emptied — and the
      snapshot names something the owner has since changed their mind about. If
      the restore then fires, it restores the wrong one, which is worse than
      restoring the right one.

      So the snapshot tracks the selection for as long as the attempt is live:
      it means "the last thing they chose while this was open", not "the first".
    */
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "changed-mind");
      await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
        workspaceId,
        managedStorage: true,
        fastSearch: false,
      });
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      // Second thoughts, while the attempt is still open.
      await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
        workspaceId,
        managedStorage: false,
        fastSearch: true,
      });
      const row = await t.run((ctx) => ctx.db.get(sessionId));
      expect(row?.selectedAtCheckout).toEqual({
        managedStorage: false,
        fastSearch: true,
      });

      // And if the restore fires, it restores the newer choice.
      await t.run(async (ctx) => {
        const plan = await ctx.db.query("workspacePlans").unique();
        await ctx.db.patch(plan!._id, { managedStorage: false, fastSearch: false });
      });
      await postWebhook(t, checkoutCompleted(sessionId));
      const view = await asUser(t, owner).query(api.functions.billing.status, {
        workspaceId,
      });
      expect(view.active).toEqual({ managedStorage: false, fastSearch: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a checkout that completed without being paid for turns nothing on", async () => {
    // Stripe's `payment_status` can be `unpaid` on a completed session — a
    // bank-debit method that has not cleared, among others. A session is
    // judged on its own vocabulary, never on a subscription's.
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "unpaid");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      const response = await postWebhook(
        t,
        checkoutCompleted(sessionId, { payment_status: "unpaid" }),
      );
      expect(response.status).toBe(200);
      expect(
        (await asUser(t, owner).query(api.functions.billing.status, { workspaceId }))
          .status,
      ).toBe("none");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a type nobody handles is accepted and ignored", async () => {
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "unhandled");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      const response = await postWebhook(t, {
        ...checkoutCompleted(sessionId),
        type: "invoice.payment_failed",
      });
      // 200: retrying will not make us handle it.
      expect(response.status).toBe(200);
      expect(
        (await asUser(t, owner).query(api.functions.billing.status, { workspaceId }))
          .status,
      ).toBe("none");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a signed body that is not an event at all is a bad request", async () => {
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      expect((await postWebhook(t, { hello: "world" })).status).toBe(400);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the response says nothing about which context or subscription", async () => {
    // The caller is Stripe and does not need it, and during a signing-secret
    // leak this endpoint is reachable by more people than we would like.
    const t = setupTest();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SIGNING_SECRET);
    try {
      const { owner, workspaceId } = await context(t, "quiet");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      const response = await postWebhook(t, checkoutCompleted(sessionId));
      const text = await response.text();
      expect(text).not.toContain(String(workspaceId));
      expect(text).not.toContain("sub_FAKE");
      expect(text).not.toContain("cus_FAKE");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("deleting a context stops the money", () => {
  /*
    WORSE THAN "WE FORGOT TO CANCEL".

    `startPortal` is the only cancellation path in the product, and it is
    reached from that context's Premium section. Delete the context and the
    customer is billed every month with no route in the product to stop it —
    that is a chargeback, not a loose end.

    `cascadeCoverage.test.ts` could not have caught this: it derives its
    obligation from `encrypted*` field names, and neither billing table has one.
    Both are swept now, and that test has been widened so a table carrying an
    external obligation cannot pass by having no credential in it.
  */
  async function deleteTheContext(t: TestConvex, owner: Id<"users">) {
    // The real teardown, through the real public mutation.
    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});
  }

  test("a live subscription is scheduled for cancellation, then the rows go", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "teardown");
    await chooseBoth(t, owner, workspaceId);
    await t.run(async (ctx) => {
      const plan = await ctx.db.query("workspacePlans").unique();
      await ctx.db.patch(plan!._id, {
        status: "active",
        stripeCustomerId: "cus_FAKE",
        stripeSubscriptionId: "sub_FAKE",
      });
    });

    await deleteTheContext(t, owner);

    // Nothing left pointing at a subscription nobody can reach any more…
    const plans = await t.run((ctx) => ctx.db.query("workspacePlans").collect());
    const sessions = await t.run((ctx) => ctx.db.query("billingSessions").collect());
    expect(plans).toHaveLength(0);
    expect(sessions).toHaveLength(0);
    // …and the cancellation was queued before the row carrying its id was
    // deleted, which is the whole reason it is scheduled with the id in the
    // args rather than looked up afterwards.
    expect(
      await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect()),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: expect.stringContaining("cancelSubscription"),
        }),
      ]),
    );
  });

  test("a context that never paid schedules nothing", async () => {
    // No subscription, nothing to cancel. A schedule here would be a call to
    // Stripe about an id we do not have.
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "teardown-free");
    await chooseBoth(t, owner, workspaceId);
    await deleteTheContext(t, owner);
    const scheduled = await t.run(
      async (ctx) => await ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduled.filter((row) => row.name.includes("cancelSubscription")),
    ).toHaveLength(0);
  });
});

describe("nothing here gates the exit", () => {
  test("no billing function names an export, a download or a hand-off", async () => {
    /*
      Non-negotiable #1: the exit is free, identical on both plans, and works
      after a cancellation. The failure this catches is a function being
      *added* — `billing.exportAllowed`, a quota, an expiry — so it is a shape
      test over the module's own exports, the same guard `premium.test.ts`
      keeps over the pure module.
    */
    const billing = await import("../functions/billing");
    const exits = Object.keys(billing).filter((name) =>
      /export|download|handoff|handOff|purge|delete/i.test(name),
    );
    expect(
      exits,
      "a plan must never decide whether somebody can leave with their notes",
    ).toEqual([]);
  });
});

/**
 * WHERE STRIPE SENDS SOMEBODY BACK TO.
 *
 * The one moment this product cannot afford to get wrong is the one it did:
 * `success_url` was `/settings?settings=premium&checkout=done`, and
 * `/settings` is not a route in the app — settings became an overlay over a
 * context's own page. A completed payment landed on `+not-found`.
 *
 * These tests pin the exact strings sent to Stripe, because that is the only
 * place the mistake was visible. The *other* half of the guard is in the app
 * (`apps/mobile/__tests__/checkoutReturn.test.ts`): a path this file says is
 * right and the router does not resolve is still a 404, and only that side can
 * ask the router.
 *
 * ## Sabotage record
 *
 *   `createCheckoutSession` back to the literal `/settings?...` path        1
 *   `sessionForAction` reporting "settings" for an onboarding attempt       1
 *   `portalReturnPath` swapped for the old literal                         1
 */
describe("the return from Stripe", () => {
  /** What Stripe was asked for, as the form parameters it received. */
  function captureStripe(): {
    params: () => URLSearchParams;
    all: () => URLSearchParams[];
    calls: () => number;
  } {
    const seen: URLSearchParams[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      seen.push(new URLSearchParams(init.body));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ url: "https://checkout.invalid/session" }),
      };
    });
    return { params: () => seen[seen.length - 1], all: () => seen, calls: () => seen.length };
  }

  async function sellingContext(t: TestConvex, slug: string) {
    await seedAppSecret(t, STRIPE_API_KEY_SECRET, "sk_test_obviously_fake_key");
    vi.stubEnv(STRIPE_PRICE_ID_ENV_VAR, FAKE_PRICE_ID);
    vi.stubEnv("APP_ORIGIN", "https://app.example.invalid");
    return await context(t, slug);
  }

  test("a checkout from settings returns to that context's Premium section", async () => {
    const t = setupTest();
    const stripe = captureStripe();
    try {
      const { owner, workspaceId } = await sellingContext(t, "return-settings");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await t.action(internal.functions.billingStripe.createCheckoutSession, { sessionId });

      expect(stripe.calls()).toBe(1);
      expect(stripe.params().get("success_url")).toBe(
        "https://app.example.invalid/console/@return-settings?settings=premium&checkout=done",
      );
      expect(stripe.params().get("cancel_url")).toBe(
        "https://app.example.invalid/console/@return-settings?settings=premium&checkout=cancelled",
      );
      // The path that shipped, and the reason this file has a section.
      expect(stripe.params().get("success_url")).not.toContain("/settings?");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("a checkout from first run returns to first run", async () => {
    /*
      Somebody thirty seconds into their first session has no context page to
      be sent to — they are mid-flow, with a name claimed and no storage — so
      sending them to a console that has neither is sending them to a dead end
      wearing a different URL.
    */
    const t = setupTest();
    const stripe = captureStripe();
    try {
      const { owner, workspaceId } = await sellingContext(t, "return-firstrun");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId, origin: "onboarding" },
      );
      await t.action(internal.functions.billingStripe.createCheckoutSession, { sessionId });

      expect(stripe.params().get("success_url")).toBe(
        "https://app.example.invalid/welcome?checkout=done",
      );
      expect(stripe.params().get("cancel_url")).toBe(
        "https://app.example.invalid/welcome?checkout=cancelled",
      );
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("a row written before origin existed is read as a settings attempt", async () => {
    // The field is optional because rows predate it, and the fallback has to be
    // the origin the product actually had — not a crash, and not first run.
    const t = setupTest();
    const stripe = captureStripe();
    try {
      const { owner, workspaceId } = await sellingContext(t, "return-legacy");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId, origin: "onboarding" },
      );
      await t.run((ctx) => ctx.db.patch(sessionId, { origin: undefined }));
      await t.action(internal.functions.billingStripe.createCheckoutSession, { sessionId });

      expect(stripe.params().get("success_url")).toContain("/console/@return-legacy?settings=premium");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("a context deleted mid-checkout is not sent anywhere at all", async () => {
    /*
      The return URL is built from the context's name. Without this the slug
      falls back to an empty string and Stripe is handed
      `/console/@?settings=premium` — a URL that resolves to nothing — as the
      place to send somebody after they have paid. There is nothing left to
      upgrade, so the attempt is skipped instead.
    */
    const t = setupTest();
    const stripe = captureStripe();
    try {
      const { owner, workspaceId } = await sellingContext(t, "vanished");
      await chooseBoth(t, owner, workspaceId);
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startCheckout,
        { workspaceId },
      );
      await t.run((ctx) => ctx.db.delete(workspaceId));
      const result = await t.action(
        internal.functions.billingStripe.createCheckoutSession,
        { sessionId },
      );

      expect(result.status).toBe("skipped");
      /*
        Every call, not a count: `startCheckout` also schedules this action, and
        the scheduled run happens with the workspace still present. What must
        never happen is a URL naming no context reaching Stripe at all.
      */
      for (const params of stripe.all()) {
        expect(params.get("success_url")).not.toContain("/@?");
        expect(params.get("cancel_url")).not.toContain("/@?");
      }
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("the billing portal returns to the section it was opened from", async () => {
    const t = setupTest();
    const stripe = captureStripe();
    try {
      const { owner, workspaceId } = await sellingContext(t, "return-portal");
      await t.run(async (ctx) => {
        await ctx.db.insert("workspacePlans", {
          workspaceId,
          managedStorage: true,
          fastSearch: false,
          status: "active",
          stripeCustomerId: "cus_FAKE0000",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      });
      const { sessionId } = await asUser(t, owner).mutation(
        api.functions.billing.startPortal,
        { workspaceId },
      );
      await t.action(internal.functions.billingStripe.createPortalSession, { sessionId });

      expect(stripe.params().get("return_url")).toBe(
        "https://app.example.invalid/console/@return-portal?settings=premium",
      );
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});

/**
 * WHAT THIS DEPLOYMENT CAN ACTUALLY GIVE SOMEBODY.
 *
 * Selling and delivering are different questions, and the console has to ask
 * the second one before it draws a managed-storage option. A deployment with a
 * Stripe price and no customer-data account can take $20 and has nowhere to
 * put the bucket that money buys — which is the worst failure this flow has,
 * because it happens *after* the payment.
 *
 * ## Sabotage record
 *
 *   `managedStorageAvailable` answering `deploymentSells()` alone         1
 *   the malformed account id thrown rather than caught                    1
 */
describe("whether managed storage can be offered at all", () => {
  const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

  async function availability(t: TestConvex, slug: string): Promise<boolean> {
    const { owner, workspaceId } = await context(t, slug);
    const row = await asUser(t, owner).query(api.functions.billing.status, { workspaceId });
    return row.managedStorageAvailable;
  }

  test("a deployment that sells nothing offers nothing", async () => {
    const t = setupTest();
    expect(await availability(t, "offers-nothing")).toBe(false);
  });

  test("a price with nowhere to put a bucket is still not an offer", async () => {
    // The case worth having a test for: everything Stripe needs is present and
    // the thing being sold cannot be delivered.
    const t = setupTest();
    vi.stubEnv(STRIPE_PRICE_ID_ENV_VAR, FAKE_PRICE_ID);
    try {
      expect(await availability(t, "sells-only")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("both, and it is an offer", async () => {
    const t = setupTest();
    vi.stubEnv(STRIPE_PRICE_ID_ENV_VAR, FAKE_PRICE_ID);
    vi.stubEnv(MANAGED_R2_ACCOUNT_ID_ENV_VAR, ACCOUNT_ID);
    try {
      expect(await availability(t, "sells-and-holds")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("an operator's typo does not take the status query down for every member", async () => {
    /*
      `managedAccountId` throws on set-but-malformed, which is right where
      provisioning reads it and wrong here: this query is called by every
      member of every context, and one bad environment variable would answer
      all of them with an exception. It reads as "cannot offer it", which is
      both true and survivable.
    */
    const t = setupTest();
    vi.stubEnv(STRIPE_PRICE_ID_ENV_VAR, FAKE_PRICE_ID);
    vi.stubEnv(MANAGED_R2_ACCOUNT_ID_ENV_VAR, "not-an-account-id");
    try {
      expect(await availability(t, "typo")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
