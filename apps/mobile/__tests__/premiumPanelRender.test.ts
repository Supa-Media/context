/**
 * @jest-environment jsdom
 */

/**
 * THE PREMIUM SECTION, ACTUALLY RENDERED.
 *
 * `premiumSettings.test.ts` proves the rules. This proves the screen obeys
 * them, which is not the same thing and has not been the same thing here
 * before: `settingsOverlayRender.test.ts`'s own header lists four mutations
 * that every pure test in that feature was green for.
 *
 * The mutations this file is aimed at, all of which look like tidying:
 *
 *  - moving the export promise inside the `status !== null` branch, so a
 *    context whose plan could not be read loses it;
 *  - moving it inside the "premium" branch, so the free plan loses it;
 *  - drawing the toggles for a member, whose presses the server refuses;
 *  - drawing the upgrade button for the landing page's demo console, where
 *    pressing it does nothing at all;
 *  - reading a plan status this build does not know as "free", and offering to
 *    sell against a vocabulary we do not share.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts as measured over this
 * file, `premiumSettings.test.ts` and `settingsSections.test.ts` together.
 *
 *   export promise moved inside the `status !== null` branch          0 → 3
 *   export promise shortened on the free plan                             7
 *   toggles drawn for a member instead of the read-only list              1
 *   upgrade button drawn when `view.upgrade` is absent                    1
 *   `premiumControl` re-deriving ownership instead of reading it          1
 *   `premiumControl` offering upgrade with nothing selected               3
 *   `premiumStateOf` reading an unknown status as "free"                  2
 *   `usageLine` inventing a byte figure from the note count               1
 *   `describeSessionFailure` rendering an unknown code raw                1
 *
 * Added after the adversarial review, run against a committed tree:
 *
 *   `describePremium` telling a member the owner's card was declined       2
 *   `premiumPill` still labelling a member's screen "Payment failed"      2
 *
 * **The first row is 0 → 3 and the 0 is the finding.** The first attempt at it
 * produced unbalanced JSX, so the suite failed to compile rather than failing a
 * test — which reports as a suite error and, to a script counting "Tests: N
 * failed", as zero. A sabotage that does not compile has measured nothing. Run
 * as a real conditional it fails three: the two screens where nothing could be
 * read, and the assertion that the sentence is identical everywhere.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PremiumBody } from "../features/console/settings/panels/PremiumPanel";
import {
  EXPORT_PROMISE,
  demoPremiumView,
  unreadablePremiumView,
  type PremiumStatus,
  type PremiumView,
} from "../features/console/settings/panels/premium";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(
  view: PremiumView,
  extra: { returned?: "done" | "cancelled" | null; slowAfter?: number } = {},
): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, {
    onUncaughtError: () => {},
    onCaughtError: () => {},
  });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(PremiumBody, { view, section: "premium", ...extra }),
    );
  });
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
  storageIsManaged: false,
  ...over,
});

const view = (over: Partial<PremiumView> = {}): PremiumView => ({
  status: status(),
  loading: false,
  session: null,
  choose: async () => {},
  upgrade: async () => {},
  manageBilling: async () => {},
  ...over,
});

/** Every state a person can actually be shown, including the two failures. */
const EVERY_SCREEN: Array<[string, PremiumView]> = [
  ["free", view()],
  [
    "free with something chosen",
    view({
      status: status({ selected: { managedStorage: true, fastSearch: false } }),
    }),
  ],
  [
    "premium",
    view({
      status: status({
        status: "active",
        selected: { managedStorage: true, fastSearch: true },
        active: { managedStorage: true, fastSearch: true },
        hasStripeCustomer: true,
        currentPeriodEnd: 1_782_000_000,
      }),
    }),
  ],
  [
    "past due",
    view({ status: status({ status: "past_due", hasStripeCustomer: true }) }),
  ],
  [
    "cancelled",
    view({
      status: status({
        status: "canceled",
        hasStripeCustomer: true,
        selected: { managedStorage: true, fastSearch: false },
      }),
    }),
  ],
  [
    "a member",
    view({
      status: status({ canManage: false }),
      choose: undefined,
      upgrade: undefined,
      manageBilling: undefined,
    }),
  ],
  [
    "a member on a context whose payment failed",
    view({
      status: status({
        status: "past_due",
        canManage: false,
        hasStripeCustomer: true,
      }),
      choose: undefined,
      upgrade: undefined,
      manageBilling: undefined,
    }),
  ],
  [
    "a deployment that does not sell",
    view({ status: status({ configured: false }) }),
  ],
  [
    "a status this build does not know",
    view({ status: status({ status: "paused" }) }),
  ],
  ["still loading", view({ status: null, loading: true })],
  ["unreadable", unreadablePremiumView()],
  ["the landing page's demo", demoPremiumView()],
];

describe("the export promise is on every one of these screens", () => {
  test.each(EVERY_SCREEN)("%s", (_name, current) => {
    /*
      THE TEST THIS FILE EXISTS FOR.

      Non-negotiable #1: the exit is free, identical on both plans, and works
      after a cancellation. A screen that asks for money is the one place where
      moving this sentence one branch inwards reads as tidying and is a product
      change — so it is asserted on the plan that has not paid, on the plan
      that has, on the one that failed to pay, on a deployment that sells
      nothing, and on the two screens where nothing could be read at all.
    */
    const host = mount(current);
    const promise = host.querySelector(
      '[data-testid="premium-export-promise"]',
    );
    expect(promise).not.toBeNull();
    expect(host.textContent ?? "").toContain(EXPORT_PROMISE);
  });

  test("and it is the same sentence every time, not a shortened one", () => {
    const rendered = new Set(
      EVERY_SCREEN.map(([, current]) => {
        const host = mount(current);
        return (
          host.querySelector('[data-testid="premium-export-promise"]')
            ?.textContent ?? ""
        );
      }),
    );
    expect(rendered.size).toBe(1);
    expect([...rendered][0]).toContain("after you cancel");
  });

  test("nothing on this screen asks somebody to pay to keep their notes", () => {
    for (const [, current] of EVERY_SCREEN) {
      const text = mount(current).textContent ?? "";
      // The upsell shapes: an export that is "included", one that "requires" a
      // plan, one that is "available on" one.
      expect(text).not.toMatch(
        /export[^.]{0,40}(included|requires|available on)/i,
      );
      expect(text).not.toMatch(
        /(upgrade|premium)[^.]{0,30}to (export|download)/i,
      );
    }
  });
});

describe("managed-storage migration", () => {
  test("shows the measured percentage and current phase", () => {
    const host = mount(
      view({
        status: status({
          status: "active",
          selected: { managedStorage: true, fastSearch: false },
          active: { managedStorage: true, fastSearch: false },
          managedProvisioning: "running",
          managedMigrationPhase: "copy",
          managedMigrationObjectsTotal: 50,
          managedMigrationObjectsProcessed: 40,
        }),
      }),
    );
    const text =
      host.querySelector('[data-testid="managed-storage-migration"]')
        ?.textContent ?? "";
    expect(text).toMatch(/copying into managed storage/i);
    expect(text).toMatch(/40 of 50 files/i);
    expect(text).toMatch(/80% through this step/i);
  });

  test("a failed copy keeps the original-storage promise and offers the owner retry", () => {
    const host = mount(
      view({
        status: status({
          status: "active",
          selected: { managedStorage: true, fastSearch: false },
          active: { managedStorage: true, fastSearch: false },
          managedProvisioning: "failed",
        }),
        retryManagedStorage: async () => {},
      }),
    );
    expect(
      host.querySelector('[data-testid="managed-storage-migration"]')
        ?.textContent,
    ).toMatch(/original remains connected and untouched/i);
    expect(
      host.querySelector('[data-testid="managed-storage-retry"]'),
    ).not.toBeNull();
  });
});

describe("what each screen offers", () => {
  test("an owner on the free plan with a choice made is offered the upgrade", () => {
    const host = mount(
      view({
        status: status({
          selected: { managedStorage: true, fastSearch: false },
        }),
      }),
    );
    expect(
      host.querySelector('[data-testid="premium-upgrade"]'),
    ).not.toBeNull();
    expect(host.querySelector('[data-testid="premium-manage"]')).toBeNull();
  });

  test("the CUJ account gets a no-charge activation and no Stripe control once active", () => {
    const free = mount(
      view({
        status: status({
          isTestAccount: true,
          selected: { managedStorage: true, fastSearch: true },
        }),
      }),
    );
    expect(free.textContent ?? "").toContain("Activate test Premium");

    const active = mount(
      view({
        status: status({
          status: "active",
          isTestAccount: true,
          selected: { managedStorage: true, fastSearch: true },
          active: { managedStorage: true, fastSearch: true },
        }),
      }),
    );
    expect(active.querySelector('[data-testid="premium-upgrade"]')).toBeNull();
    expect(active.querySelector('[data-testid="premium-manage"]')).toBeNull();
  });

  test("only the CUJ view offers scoped two-step workspace cleanup", () => {
    const ordinary = mount(view());
    expect(
      ordinary.querySelector('[data-testid="premium-test-cleanup"]'),
    ).toBeNull();

    const testAccount = mount(
      view({
        status: status({ isTestAccount: true }),
        deleteTestWorkspace: async () => {},
      }),
    );
    expect(
      testAccount.querySelector(
        '[data-testid="premium-delete-test-workspace"]',
      ),
    ).not.toBeNull();
    expect(testAccount.textContent ?? "").toContain(
      "Existing contexts and buckets are untouched",
    );
  });

  test("an owner with nothing chosen is told what to tick", () => {
    const host = mount(view());
    expect(host.querySelector('[data-testid="premium-upgrade"]')).toBeNull();
    expect(host.textContent ?? "").toContain("Tick managed storage");
  });

  test("a paying context goes to the portal", () => {
    const host = mount(
      view({ status: status({ status: "active", hasStripeCustomer: true }) }),
    );
    expect(host.querySelector('[data-testid="premium-manage"]')).not.toBeNull();
  });

  test("a member gets the plan and no controls at all", () => {
    const host = mount(
      view({
        status: status({
          canManage: false,
          selected: { managedStorage: true, fastSearch: false },
        }),
        choose: undefined,
        upgrade: undefined,
        manageBilling: undefined,
      }),
    );
    expect(host.querySelector('[data-testid="premium-upgrade"]')).toBeNull();
    expect(host.querySelector('[data-testid="premium-manage"]')).toBeNull();
    // No switches either — the two entitlements are read out instead.
    expect(
      host.querySelector('[data-testid="premium-entitlement-fastSearch"]'),
    ).toBeNull();
    expect(host.textContent ?? "").toContain("Managed storage");
  });

  test("the demo console draws the section and nothing pressable", () => {
    const host = mount(demoPremiumView());
    expect(host.querySelector('[data-testid="premium-upgrade"]')).toBeNull();
    expect(host.querySelector('[data-testid="premium-manage"]')).toBeNull();
    expect(host.querySelector('[data-testid="premium-continue"]')).toBeNull();
    // And it is the free plan, not a claim about a context that does not exist.
    expect(host.textContent ?? "").toContain("free plan");
  });

  test("a member is never shown the owner's card being declined", () => {
    // Asserted on the rendered screen and not only on the copy function: the
    // money fields were owner-only on the wire and this sentence was not.
    const host = mount(
      view({
        status: status({
          status: "past_due",
          canManage: false,
          hasStripeCustomer: true,
        }),
        choose: undefined,
        upgrade: undefined,
        manageBilling: undefined,
      }),
    );
    const text = host.textContent ?? "";
    expect(text).not.toMatch(/update the card/i);
    expect(text).not.toMatch(/payment did not go through/i);
    /*
      THE PILL COUNTS AS TELLING THEM.

      The copy narrowed and the chip beside it went on reading "Payment
      failed" — the same disclosure in two words instead of two sentences.
      Nothing caught it until the screen was rendered and looked at, which is
      why this assertion is over the whole text rather than over the paragraph.
    */
    expect(text).not.toMatch(/payment failed/i);
    // …while the owner's own screen still says exactly that, because they can
    // act on it.
    const owner = mount(
      view({ status: status({ status: "past_due", hasStripeCustomer: true }) }),
    );
    expect(owner.textContent ?? "").toMatch(/update the card/i);
  });

  test("a status this build does not know offers nothing to buy", () => {
    const host = mount(view({ status: status({ status: "paused" }) }));
    expect(host.querySelector('[data-testid="premium-upgrade"]')).toBeNull();
    expect(host.textContent ?? "").toContain("not available here");
  });

  test("a ready checkout hands over the second press rather than navigating on its own", () => {
    const host = mount(
      view({
        status: status({
          selected: { managedStorage: true, fastSearch: false },
        }),
        session: {
          status: "ready",
          kind: "checkout",
          url: "https://checkout.invalid/x",
        },
      }),
    );
    expect(
      host.querySelector('[data-testid="premium-continue"]'),
    ).not.toBeNull();
  });

  test("a failed attempt says so in our words", () => {
    const host = mount(
      view({
        status: status(),
        session: {
          status: "failed",
          kind: "checkout",
          errorCode: "NOT_CONFIGURED",
        },
      }),
    );
    expect(host.textContent ?? "").toContain("not set up on this deployment");
  });
});

describe("what the section says about itself", () => {
  test("the price is on the card", () => {
    expect(mount(view()).textContent ?? "").toContain("$5 a month");
  });

  test("per context, said out loud, because it is what people get wrong", () => {
    const text = mount(view()).textContent ?? "";
    expect(text).toMatch(/per context/i);
  });

  test("the heading is the row's own label, not a literal", () => {
    // They were separate strings once and drifted: a row that said "Mail,
    // calendar & chats" opened a panel headed "Integrations".
    expect(mount(view()).textContent ?? "").toContain("Premium");
  });
});

/**
 * COMING BACK FROM STRIPE, ON THE SCREEN.
 *
 * `checkoutReturn.test.ts` proves the URL lands on this section; these prove
 * the section then says something true when it does. The state that matters is
 * the middle one: paid, and the webhook has not landed. It must not say
 * "failed", must not spin without a sentence, and must say the work finishes
 * without this tab — because it does, and somebody who has just been charged
 * is entitled to know they can close it.
 *
 * ## Sabotage record
 *
 *   the settling notice rendered only when the plan is already active     1
 *   the slow copy replacing the spinner rather than the words             1
 *   `checkoutReturnCopy` treating an unknown outcome as "done"            1
 */
describe("the return from Stripe", () => {
  test("paid, and the plan has not caught up: reassurance, not a failure", () => {
    const container = mount(view(), { returned: "done" });
    const notice = container.querySelector(
      '[data-testid="premium-checkout-return"]',
    );
    expect(notice).not.toBeNull();
    const words = notice?.textContent ?? "";
    expect(words).toContain("Payment received");
    expect(words).toContain("a few seconds");
    expect(words.toLowerCase()).not.toContain("failed");
    expect(words.toLowerCase()).not.toContain("error");
  });

  test("and it does not say they are on the free plan in the same breath", () => {
    /*
      THE DEFECT THIS CASE EXISTS FOR, FOUND BY LOOKING AT THE SCREEN.

      The settling copy was a notice drawn *above* the plan card, and the card
      went on saying what it always says — so "Payment received. Setting up
      this context." sat directly on top of "This context is on the free
      plan". Two statements about somebody's money, contradicting each other,
      three seconds after they were charged. Every unit test passed: each
      sentence is correct on its own, and only the two together are wrong.

      The plan genuinely has not changed yet, so the fix is to stop asserting
      the old state while telling them the new one is coming.
    */
    const container = mount(view(), { returned: "done" });
    const words = container.textContent ?? "";
    expect(words).toContain("Payment received");
    expect(words).not.toContain("This context is on the free plan");
  });

  test("a cancelled return may say it, because the two agree", () => {
    // "No payment was taken" and "you are on the free plan" are the same fact
    // told twice, which is reassurance rather than contradiction.
    const container = mount(view(), { returned: "cancelled" });
    const words = container.textContent ?? "";
    expect(words).toContain("No payment was taken");
    expect(words).toContain("This context is on the free plan");
  });

  test("still waiting: different words, same spinner, and permission to leave", () => {
    jest.useFakeTimers();
    try {
      const container = mount(view(), { returned: "done", slowAfter: 20 });
      act(() => {
        jest.advanceTimersByTime(25);
      });
      const words =
        container.querySelector('[data-testid="premium-checkout-return"]')
          ?.textContent ?? "";
      expect(words).toContain("Still working");
      expect(words).toContain("You can close this");
      expect(words.toLowerCase()).not.toContain("failed");
    } finally {
      jest.useRealTimers();
    }
  });

  test("paid, and the plan is active: said once, out of the way", () => {
    const container = mount(
      view({ status: status({ status: "active", hasStripeCustomer: true }) }),
      { returned: "done" },
    );
    const words =
      container.querySelector('[data-testid="premium-checkout-return"]')
        ?.textContent ?? "";
    expect(words).toContain("Payment received");
    expect(words).toContain("Premium is on");
    expect(words).not.toContain("a few seconds");
  });

  test("came back without paying: nothing was charged, and no second pitch", () => {
    const container = mount(view(), { returned: "cancelled" });
    const words =
      container.querySelector('[data-testid="premium-checkout-return"]')
        ?.textContent ?? "";
    expect(words).toContain("No payment was taken");
    expect(words).toContain("nothing was charged");
    // A cancelled checkout is not an opportunity. There is no discount to offer
    // and offering one would be a different product.
    expect(words.toLowerCase()).not.toContain("discount");
    expect(words.toLowerCase()).not.toContain("are you sure");
  });

  test("an ordinary visit says nothing about a checkout at all", () => {
    const container = mount(view());
    expect(
      container.querySelector('[data-testid="premium-checkout-return"]'),
    ).toBeNull();
  });

  test("and the export promise survives every one of them", () => {
    for (const returned of ["done", "cancelled", null] as const) {
      const container = mount(view(), { returned });
      expect(container.textContent ?? "").toContain(EXPORT_PROMISE);
    }
  });
});
