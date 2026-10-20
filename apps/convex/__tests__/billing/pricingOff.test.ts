/**
 * CONTEXT IS FREE: NO PLAN, NO PRICE, NO NOTE CAP (owner, 2026-10-20).
 *
 * The suite runs with `CONTEXT_PRICING=on` so the dormant paid model stays
 * proven. Production runs without it, and this file proves what that means:
 * every Premium gate is open, a context on storage we run that nobody pays
 * for has no cap, and nothing can be bought.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `premiumFeaturesOn` reading `planIsPaying` alone                     2
 *   `noteCapFor` ignoring the switch                                     1
 *   `startCheckout` not refusing while free                              1
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import { asUser, captureError, errorCode, seedStorageBinding, setupTest } from "../fixtures.helpers";
import { managedBucketName } from "../../functions/lib/managedStorage";
import { PRICING_ENV_VAR, premiumFeaturesOn, pricingIsOn } from "../../functions/lib/premium";
import { context } from "./fixtures.helpers";

function free() {
  vi.stubEnv(PRICING_ENV_VAR, "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("with pricing off", () => {
  test("absent is free, and only `on` charges", () => {
    expect(pricingIsOn({})).toBe(false);
    expect(pricingIsOn({ [PRICING_ENV_VAR]: "off" })).toBe(false);
    expect(pricingIsOn({ [PRICING_ENV_VAR]: " ON " })).toBe(true);
  });

  test("every Premium gate is open for a context nobody pays for", () => {
    free();
    for (const status of ["none", "past_due", "canceled", "unknown"] as const) {
      expect(premiumFeaturesOn(status)).toBe(true);
    }
  });

  test("a context on storage we run has no note cap, paying or not", async () => {
    free();
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "free-uncapped");
    await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket: managedBucketName(workspaceId) });
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("workspacePlans", {
        workspaceId,
        status: "canceled" as const,
        managedStorage: true,
        fastSearch: false,
        freeManaged: true,
        createdAt: now,
        updatedAt: now,
      }),
    );
    expect(await t.query(internal.functions.billing.noteCap, { workspaceId })).toBeNull();
    const status = await asUser(t, owner).query(api.functions.billing.status, { workspaceId });
    expect(status.free).toBe(true);
    expect(status.noteCap).toBeUndefined();
    expect(status.configured).toBe(false);
  });

  test("nothing can be bought", async () => {
    free();
    vi.stubEnv("STRIPE_PRICE_ID", "price_TESTfake123");
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "free-no-checkout");
    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.billing.startCheckout, { workspaceId }),
    );
    expect(errorCode(error)).toBe("CONTEXT_IS_FREE");
  });
});

describe("winding billing down", () => {
  test("names only the subscriptions Stripe has not ended", async () => {
    const t = setupTest();
    const { workspaceId: live } = await context(t, "wind-live");
    const { workspaceId: ended } = await context(t, "wind-ended");
    const { workspaceId: founder } = await context(t, "wind-founder");
    const now = Date.now();
    const row = { managedStorage: false, fastSearch: true, createdAt: now, updatedAt: now };
    await t.run(async (ctx) => {
      await ctx.db.insert("workspacePlans", {
        ...row, workspaceId: live, status: "active", stripeSubscriptionId: "sub_live",
      });
      await ctx.db.insert("workspacePlans", {
        ...row, workspaceId: ended, status: "canceled", stripeSubscriptionId: "sub_ended",
      });
      // A founder's plan is held active after Stripe ends it; Stripe's word decides.
      await ctx.db.insert("workspacePlans", {
        ...row, workspaceId: founder, status: "active", stripeStatus: "canceled",
        founding: true, stripeSubscriptionId: "sub_founder_ended",
      });
    });
    expect(await t.query(internal.functions.billingWindDown.liveSubscriptionIds, {})).toEqual([
      "sub_live",
    ]);
  });
});
