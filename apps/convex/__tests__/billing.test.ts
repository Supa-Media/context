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
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { STRIPE_PRICE_ID_ENV_VAR } from "../functions/lib/premium";
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
      expect(second!.updatedAt).toBe(first!.updatedAt);
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
