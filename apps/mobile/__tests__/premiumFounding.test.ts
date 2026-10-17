/**
 * @jest-environment jsdom
 */

/**
 * FOUNDING PREMIUM, AS A FOUNDER READS IT.
 *
 * The first 100 accounts are Premium at no charge (`docs/decisions/billing.md`,
 * "Founding Premium"): an active plan, `founding: true`, no Stripe customer.
 * The control plane refuses a checkout on any active plan, so nothing on a
 * founder's screen may offer one — and nothing may read as if they pay.
 *
 * The bug this file exists for: `premiumControl` returned "upgrade" for that
 * plan, so Settings > Premium drew "Upgrade to Premium" on a plan that was
 * already Premium, and pressing it showed an error. The price row beside it
 * said "$5 a month" with the held-price promise underneath.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `premiumControl` without the active-with-no-customer rule             3
 *   `foundingAtNoCharge` ignoring `hasStripeCustomer`                      2
 *   the panel drawing the price row for a founder                         1
 *   `ManagedConfirm` keeping the payment copy for a founder               1
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PremiumBody } from "../features/console/settings/panels/PremiumPanel";
import {
  EARLY_TESTER_PRICE_NOTE,
  EXPORT_PROMISE,
  premiumControl,
  type PremiumStatus,
  type PremiumView,
} from "../features/console/settings/panels/premium";
import {
  FOUNDING_PRICE_LINE,
  foundingAtNoCharge,
} from "../features/console/settings/panels/founding";
import { entitlementsHint } from "../features/console/settings/panels/premiumEntitlements";
import { ManagedConfirm } from "../features/onboarding/steps/ManagedConfirm";
import { StorageChoice } from "../features/console/storage/StorageChoice";
import { ForkStep } from "../features/onboarding/redesign/ForkStep";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function render(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(element));
  return container;
}

const status = (over: Partial<PremiumStatus> = {}): PremiumStatus => ({
  status: "none",
  selected: { managedStorage: false, fastSearch: false },
  active: { managedStorage: false, fastSearch: false },
  canManage: true,
  configured: true,
  priceCents: 500,
  currency: "usd",
  interval: "month",
  ceilingBytes: 50_000_000_000,
  storageIsManaged: true,
  ...over,
});

/** A founder exactly as `billing.status` reports one. */
const founder = (over: Partial<PremiumStatus> = {}): PremiumStatus =>
  status({
    status: "active",
    founding: true,
    hasStripeCustomer: false,
    isTestAccount: false,
    selected: { managedStorage: true, fastSearch: true },
    active: { managedStorage: true, fastSearch: true },
    keepOneSelected: true,
    ...over,
  });

const view = (over: Partial<PremiumView> = {}): PremiumView => ({
  status: founder(),
  loading: false,
  session: null,
  choose: async () => {},
  upgrade: async () => {},
  manageBilling: async () => {},
  ...over,
});

describe("which control a founder is offered", () => {
  test("an active founding plan with no customer is offered nothing", () => {
    expect(premiumControl(view())).toBe("none");
  });

  test("any active plan with no customer is offered nothing: the server refuses that checkout", () => {
    expect(premiumControl(view({ status: founder({ founding: undefined }) }))).toBe("none");
  });

  test("a founder who also pays through Stripe still reaches the portal", () => {
    expect(premiumControl(view({ status: founder({ hasStripeCustomer: true }) }))).toBe("manage");
  });

  test("a free plan is still offered the upgrade", () => {
    expect(premiumControl(view({ status: status() }))).toBe("upgrade");
  });
});

describe("what counts as no charge", () => {
  test("founding, active, and not paying through Stripe", () => {
    expect(foundingAtNoCharge(founder())).toBe(true);
    expect(foundingAtNoCharge(founder({ hasStripeCustomer: true }))).toBe(false);
    expect(foundingAtNoCharge(founder({ founding: false }))).toBe(false);
    expect(foundingAtNoCharge(status())).toBe(false);
    expect(foundingAtNoCharge(null)).toBe(false);
  });

  test("the entitlements hint names no price and no billing", () => {
    const hint = entitlementsHint(founder());
    expect(hint).not.toMatch(/\$5|price|paying|Manage billing/i);
    expect(hint).toContain("no charge");
  });
});

describe("Settings > Premium for a founder", () => {
  test("no upgrade button, no price, one founding line, and the exit", () => {
    const screen = render(createElement(PremiumBody, { view: view(), section: "premium" }));
    const text = screen.textContent ?? "";
    expect(screen.querySelector('[data-testid="premium-upgrade"]')).toBeNull();
    expect(screen.querySelector('[data-testid="premium-price"]')).toBeNull();
    expect(screen.querySelector('[data-testid="premium-founding"]')?.textContent).toBe(
      FOUNDING_PRICE_LINE,
    );
    expect(text).not.toContain("Upgrade to Premium");
    expect(text).not.toContain("$5");
    expect(text).not.toContain(EARLY_TESTER_PRICE_NOTE);
    expect(text).not.toMatch(/Billed to this workspace/);
    const how = screen.querySelector<HTMLElement>('[data-testid="premium-exit-how"]');
    if (!text.includes(EXPORT_PROMISE) && how !== null) act(() => how.click());
    expect(screen.textContent ?? "").toContain(EXPORT_PROMISE);
  });

  test("a paying founder still sees the price and Manage billing", () => {
    const screen = render(
      createElement(PremiumBody, {
        view: view({ status: founder({ hasStripeCustomer: true }) }),
        section: "premium",
      }),
    );
    expect(screen.querySelector('[data-testid="premium-price"]')?.textContent).toBe("$5 a month");
    expect(screen.querySelector('[data-testid="premium-manage"]')).not.toBeNull();
    expect(screen.querySelector('[data-testid="premium-founding"]')).toBeNull();
  });
});

describe("the managed-storage confirm screen for a founder", () => {
  test("says nothing is charged and never mentions Stripe or a price", () => {
    const screen = render(
      createElement(ManagedConfirm, {
        status: founder({ storageIsManaged: false }),
        contextName: "@first",
        state: "choosing",
        onToggle: () => {},
        onContinue: () => {},
        onBack: () => {},
      }),
    );
    const text = screen.textContent ?? "";
    expect(text).toContain(FOUNDING_PRICE_LINE);
    expect(text).not.toMatch(/\$5|Stripe|subscribing|Billed monthly|after you pay/);
    expect(text).toContain(EXPORT_PROMISE);
  });
});

describe("the storage cards a founder chooses from", () => {
  test("the managed card says included, not a monthly price", () => {
    const screen = render(
      createElement(StorageChoice, {
        connect: async () => ({ status: "connected" }),
        managed: { price: "$5 a month", founding: true, onChoose: () => {} },
      }),
    );
    const card = screen.querySelector('[data-testid="choose-managed"]')?.textContent ?? "";
    expect(card).toContain(FOUNDING_PRICE_LINE);
    expect(card).toContain("Included");
    expect(card).not.toContain("$5");
  });

  test("the first-run fork names no price and no charge to come", () => {
    const screen = render(
      createElement(ForkStep, {
        offer: { kind: "paid", price: "$5 a month", founding: true },
        onPickManaged: () => {},
        onPickBYO: () => {},
      }),
    );
    const card = screen.querySelector('[data-testid="welcome-fork-fresh"]')?.textContent ?? "";
    expect(card).toContain(FOUNDING_PRICE_LINE);
    expect(card).not.toMatch(/\$5|before anything is charged/);
  });
});
