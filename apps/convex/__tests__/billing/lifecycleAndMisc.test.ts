import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  seedAppSecret,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import { MANAGED_R2_ACCOUNT_ID_ENV_VAR } from "../../functions/lib/managedStorage";
import {
  STRIPE_API_KEY_SECRET,
  STRIPE_PRICE_ID_ENV_VAR,
} from "../../functions/lib/premium";
import { TEST_ACCOUNT_EMAIL } from "../../functions/lib/testAccount";
import {
  context,
  chooseBoth,
  FAKE_PRICE_ID,
} from "./fixtures";

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
    const billing = await import("../../functions/billing");
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
 * Stripe price and no customer-data account can take $5 and has nowhere to
 * put the bucket that money buys — which is the worst failure this flow has,
 * because it happens *after* the payment.
 *
 * ## Sabotage record
 *
 *   `managedStorageAvailable` answering `deploymentSells()` alone         1
 *   the malformed account id thrown rather than caught                    1
 */
describe("production CUJ Premium bypass", () => {
  test("the exact verified test account activates without Stripe", async () => {
    const t = setupTest();
    const owner = await createUser(t, TEST_ACCOUNT_EMAIL);
    const workspaceId = await createWorkspace(t, owner, "test-premium");
    await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
      workspaceId,
      managedStorage: false,
      fastSearch: true,
    });

    await expect(
      asUser(t, owner).mutation(api.functions.billing.activateTestPremium, { workspaceId }),
    ).resolves.toEqual({ active: true });
    const status = await asUser(t, owner).query(api.functions.billing.status, { workspaceId });
    expect(status).toMatchObject({ status: "active", isTestAccount: true });
    expect(status.hasStripeCustomer).toBe(false);
  });

  test("an ordinary owner cannot use the test upgrade", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "not-test-premium");
    await chooseBoth(t, owner, workspaceId);
    await expect(
      asUser(t, owner).mutation(api.functions.billing.activateTestPremium, { workspaceId }),
    ).rejects.toMatchObject({ data: expect.objectContaining({ code: "FORBIDDEN" }) });
  });
});

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

describe("free staging storage", () => {
  function staging() {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("APP_ORIGIN", "https://staging.context.lc");
    vi.stubEnv("STAGING_CONVEX_DEPLOYMENT", "example-deployment");
    vi.stubEnv("CONVEX_CLOUD_URL", "https://example-deployment.convex.cloud");
    vi.stubEnv(MANAGED_R2_ACCOUNT_ID_ENV_VAR, "0123456789abcdef0123456789abcdef");
  }

  test("an ordinary staging owner activates a bucket once without Stripe", async () => {
    staging();
    try {
      const t = setupTest();
      const { owner, workspaceId } = await context(t, "free-stage");
      await asUser(t, owner).mutation(api.functions.billing.setEntitlements, {
        workspaceId, managedStorage: true, fastSearch: false,
      });
      expect(await asUser(t, owner).query(api.functions.billing.status, { workspaceId }))
        .toMatchObject({ stagingFreeStorage: true, priceCents: 0, configured: true, managedStorageAvailable: true, isTestAccount: false });
      await expect(asUser(t, owner).mutation(api.functions.billing.startCheckout, { workspaceId }))
        .rejects.toMatchObject({ data: expect.objectContaining({ code: "STAGING_NO_PAYMENT" }) });
      await asUser(t, owner).mutation(api.functions.billing.activateTestPremium, { workspaceId });
      const scheduled = await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
      await asUser(t, owner).mutation(api.functions.billing.activateTestPremium, { workspaceId });
      expect(await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(scheduled.length);
      expect(await t.run(ctx => ctx.db.query("billingSessions").collect())).toEqual([]);
      expect(await asUser(t, owner).query(api.functions.billing.status, { workspaceId }))
        .toMatchObject({ status: "active", active: { managedStorage: true, fastSearch: false }, managedProvisioning: "running", hasStripeCustomer: false });
    } finally { vi.unstubAllEnvs(); }
  });

  test.each([
    ["APP_ENV", "production"],
    ["APP_ORIGIN", "https://context.lc"],
    ["CONVEX_CLOUD_URL", "https://your-deployment.convex.cloud"],
    ["STAGING_CONVEX_DEPLOYMENT", ""],
  ])("%s mismatch cannot bypass the production payment gate", async (key, value) => {
    staging();
    vi.stubEnv(key, value);
    try {
      const t = setupTest();
      const { owner, workspaceId } = await context(t, "stage-denied");
      await chooseBoth(t, owner, workspaceId);
      expect(await asUser(t, owner).query(api.functions.billing.status, { workspaceId }))
        .toMatchObject({ stagingFreeStorage: false, priceCents: 500 });
      await expect(asUser(t, owner).mutation(api.functions.billing.activateTestPremium, { workspaceId }))
        .rejects.toMatchObject({ data: expect.objectContaining({ code: "FORBIDDEN" }) });
    } finally { vi.unstubAllEnvs(); }
  });

  test("staging editors cannot activate another owner's workspace", async () => {
    staging();
    try {
      const t = setupTest();
      const { owner, workspaceId } = await context(t, "stage-owner-only");
      const editor = await createUser(t, "stage-editor@example.invalid");
      await addMember(t, workspaceId, editor, "editor");
      await chooseBoth(t, owner, workspaceId);
      await expect(asUser(t, editor).mutation(api.functions.billing.activateTestPremium, { workspaceId })).rejects.toThrow();
    } finally { vi.unstubAllEnvs(); }
  });
});
