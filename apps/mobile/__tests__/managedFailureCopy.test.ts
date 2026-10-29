/**
 * A storage setup that failed says only what the billing fields prove about
 * money (`features/console/settings/panels/managedFailure.ts`).
 *
 * Reported 2026-10-29: Google's verification reviewer pressed Start fresh, was
 * never shown a checkout, and the failure read "Your payment went through".
 * The account was founding Premium, at no charge. Review of the first fix
 * added: a Stripe customer is not a payment (a cancelled subscriber or an
 * abandoned checkout keeps one), and "nothing was charged" is itself a money
 * fact, so unknown says neither.
 *
 * ## Sabotage record
 *
 * Applied, test run, named test observed failing, reverted (2026-10-29).
 *
 *  1. `storageMoneyOf` ignoring `subscriptionLive`. →
 *     "a cancelled, past-due or abandoned checkout proves nothing" fails.
 *  2. `storageMoneyOf` answering "none" when nothing proves it. → "a member,
 *     or no status, is unknown" fails.
 *  3. `managedFailureCopy` saying "nothing was charged" for unknown. → "money
 *     unknown names no money" fails.
 */
import { describe, expect, test } from "@jest/globals";

import { managedFailureCopy, managedMigrationCopy, storageMoneyOf, type PremiumStatus } from "../features/console/settings/panels/premium";

const status = (over: Partial<PremiumStatus> = {}): PremiumStatus => ({
  status: "active",
  selected: { managedStorage: true, fastSearch: false },
  active: { managedStorage: true, fastSearch: false },
  canManage: true,
  configured: true,
  priceCents: 500,
  currency: "usd",
  interval: "month",
  ceilingBytes: 50_000_000_000,
  storageIsManaged: false,
  managedProvisioning: "failed",
  ...over,
});

const MONEY = /payment|subscription|charged|paid|billing/i;
const CODES = [undefined, "CLOUDFLARE_REFUSED", "PROVISION_FAILED", "NOT_CONFIGURED"];

describe("what the billing fields prove about money for this storage", () => {
  test("a live subscription of the owner's own is subscribed", () => {
    expect(storageMoneyOf(status({ hasStripeCustomer: true, subscriptionLive: true }))).toBe("subscribed");
  });

  test("a cancelled, past-due or abandoned checkout proves nothing", () => {
    // Cancelled: the customer stays behind after the subscription ends.
    expect(storageMoneyOf(status({ hasStripeCustomer: true, subscriptionLive: false }))).toBe("unknown");
    expect(storageMoneyOf(status({ status: "canceled", hasStripeCustomer: true, subscriptionLive: false }))).toBe("unknown");
    // Past due: live in Stripe's words, but the money did not arrive.
    expect(storageMoneyOf(status({ status: "past_due", hasStripeCustomer: true, subscriptionLive: true }))).toBe("unknown");
    // Abandoned checkout: a customer and no subscription at all.
    expect(storageMoneyOf(status({ status: "none", hasStripeCustomer: true, subscriptionLive: false }))).toBe("unknown");
    // A control plane older than subscriptionLive says nothing either way.
    expect(storageMoneyOf(status({ hasStripeCustomer: true }))).toBe("unknown");
  });

  test("founding Premium, the free tier and staging have nothing to charge", () => {
    expect(storageMoneyOf(status({ founding: true, hasStripeCustomer: false, subscriptionLive: false }))).toBe("none");
    expect(storageMoneyOf(status({ status: "none", freeManaged: true, hasStripeCustomer: false }))).toBe("none");
    expect(storageMoneyOf(status({ stagingFreeStorage: true, hasStripeCustomer: true, subscriptionLive: true }))).toBe("none");
    // A founder who once subscribed is at no charge now, but the customer is
    // history this screen cannot read: unknown, never "nothing was charged".
    expect(storageMoneyOf(status({ founding: true, hasStripeCustomer: true, subscriptionLive: false }))).toBe("unknown");
    // A founder still subscribed keeps paying until they cancel.
    expect(storageMoneyOf(status({ founding: true, hasStripeCustomer: true, subscriptionLive: true }))).toBe("subscribed");
  });

  test("a member, or no status, is unknown", () => {
    // hasStripeCustomer is owner-only: absent is not false.
    expect(storageMoneyOf(status({ canManage: false }))).toBe("unknown");
    expect(storageMoneyOf(status({ founding: true }))).toBe("unknown");
    expect(storageMoneyOf(status({ freeManaged: true }))).toBe("unknown");
    expect(storageMoneyOf(null)).toBe("unknown");
    expect(storageMoneyOf(undefined)).toBe("unknown");
  });
});

describe("the failure copy says what is proven and no more", () => {
  test("money unknown names no money, and still that a retry is safe", () => {
    for (const code of CODES) {
      const copy = managedFailureCopy(code, { money: "unknown" });
      expect(copy.body).not.toMatch(MONEY);
      expect(copy.body).toMatch(/^Nothing has been lost\./);
    }
    expect(managedFailureCopy(undefined, { money: "unknown" }).body).toMatch(/will not create a second copy/);
  });

  test("nothing to charge says so, and names no payment or subscription", () => {
    for (const code of CODES) {
      const copy = managedFailureCopy(code, { money: "none" });
      expect(copy.body).not.toMatch(/payment|subscription/i);
      expect(copy.body).toMatch(/nothing has been lost, and nothing was charged/i);
    }
  });

  test("a live subscription is named as one, never as a cleared payment", () => {
    for (const code of CODES) {
      const copy = managedFailureCopy(code, { money: "subscribed" });
      expect(copy.body).toMatch(/^Your subscription is active and nothing has been lost\./);
      expect(copy.body).not.toMatch(/payment went through/i);
    }
    expect(managedFailureCopy("NOT_CONFIGURED", { money: "subscribed" }).body).toMatch(/stop the subscription/);
    expect(managedFailureCopy("NOT_CONFIGURED", { money: "unknown" }).body).not.toMatch(/stop the subscription/);
  });

  test("the Settings card reads the same", () => {
    const founder = managedMigrationCopy(status({ founding: true, hasStripeCustomer: false, subscriptionLive: false }));
    expect(founder?.failed).toBe(true);
    expect(founder?.body).toMatch(/nothing was charged/);
    expect(founder?.body).not.toMatch(/payment|subscription/i);
    const cancelled = managedMigrationCopy(status({ hasStripeCustomer: true, subscriptionLive: false }));
    expect(cancelled?.body).not.toMatch(MONEY);
    const subscriber = managedMigrationCopy(status({ hasStripeCustomer: true, subscriptionLive: true }));
    expect(subscriber?.body).toMatch(/^Your subscription is active/);
  });
});
