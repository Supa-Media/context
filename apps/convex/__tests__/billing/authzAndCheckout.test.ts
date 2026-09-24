import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  addMember,
  asUser,
  createUser,
  seedAppSecret,
  setupTest,
} from "../fixtures.helpers";
import {
  STRIPE_API_KEY_SECRET,
  STRIPE_PRICE_ID_ENV_VAR,
} from "../../functions/lib/premium";
import {
  context,
  chooseBoth,
  FAKE_PRICE_ID,
} from "./fixtures";

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
      was allowed, and the plan then activated entitling nothing. $5 a month
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
    const { owner, workspaceId } = await context(t, "tollgate");
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

