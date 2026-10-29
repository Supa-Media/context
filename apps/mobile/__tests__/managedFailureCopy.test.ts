/**
 * A storage setup that failed names a payment only when somebody paid
 * (`features/console/settings/panels/managedFailure.ts`).
 *
 * Reported 2026-10-29: Google's verification reviewer pressed Start fresh, was
 * never shown a checkout, and the failure read "Your payment went through".
 * The account was founding Premium, at no charge; the free tier's owners would
 * have read the same.
 *
 * ## Sabotage record
 *
 * Applied, test run, named test observed failing, reverted (2026-10-29).
 *
 *  1. `paidForStorage` answering `status.status === "active"`. → "founding
 *     Premium, the free tier and staging name no payment" fails.
 *  2. `managedFailureCopy` ignoring `charged`. → "a failure with nothing
 *     charged says so" fails.
 */
import { describe, expect, test } from "@jest/globals";

import { managedFailureCopy, managedMigrationCopy, paidForStorage, type PremiumStatus } from "../features/console/settings/panels/premium";

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

describe("who paid for the storage that failed", () => {
  test("a subscriber through Stripe paid", () => {
    expect(paidForStorage(status({ hasStripeCustomer: true }))).toBe(true);
  });

  test("founding Premium, the free tier and staging name no payment", () => {
    expect(paidForStorage(status({ founding: true }))).toBe(false);
    expect(paidForStorage(status({ founding: true, hasStripeCustomer: true, subscriptionLive: false }))).toBe(false);
    expect(paidForStorage(status({ status: "none", freeManaged: true }))).toBe(false);
    expect(paidForStorage(status({ stagingFreeStorage: true, hasStripeCustomer: true }))).toBe(false);
    expect(paidForStorage(status({ isTestAccount: true, hasStripeCustomer: true }))).toBe(false);
    // Unknown is unpaid: a member is never told money facts, and a guess is never said.
    expect(paidForStorage(status())).toBe(false);
    expect(paidForStorage(null)).toBe(false);
  });

  test("a failure with nothing charged says so, and still that a retry is safe", () => {
    for (const code of [undefined, "CLOUDFLARE_REFUSED", "PROVISION_FAILED", "NOT_CONFIGURED"]) {
      const copy = managedFailureCopy(code, { charged: false });
      expect(copy.body).not.toMatch(/payment|subscription/i);
      expect(copy.body).toMatch(/nothing has been lost, and nothing was charged/i);
    }
    expect(managedFailureCopy(undefined, { charged: false }).body).toMatch(/will not create a second copy/);
  });

  test("a failure that was paid for still says the payment went through", () => {
    expect(managedFailureCopy(undefined, { charged: true }).body).toMatch(/^Your payment went through and nothing has been lost\./);
    expect(managedFailureCopy("NOT_CONFIGURED", { charged: true }).body).toMatch(/stop the subscription/);
  });

  test("the Settings card reads the same: no payment for a founder", () => {
    const founder = managedMigrationCopy(status({ founding: true }));
    expect(founder?.failed).toBe(true);
    expect(founder?.body).not.toMatch(/payment/i);
    const subscriber = managedMigrationCopy(status({ hasStripeCustomer: true }));
    expect(subscriber?.body).toMatch(/Your payment went through/);
  });
});
