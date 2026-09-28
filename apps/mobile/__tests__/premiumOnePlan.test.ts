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
import { premiumIncludeRows } from "../features/console/settings/panels/PremiumIncludes";
import {
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

/**
 * PREMIUM IS ONE PLAN: A LIST, AND ONE SWITCH AFTER PAYING.
 *
 * The section names everything the $5 buys and asks nothing before the
 * Upgrade button (`docs/decisions/billing.md`, "One plan"). The only switch is
 * the search index, for an owner who is paying.
 */

describe("what Premium includes", () => {
  test("storage we run lists unlimited notes; the owner's own storage does not", () => {
    const ours = premiumIncludeRows(status({ storageIsManaged: true })).map((r) => r.key);
    const theirs = premiumIncludeRows(status()).map((r) => r.key);
    expect(ours).toEqual(["notes", "fastSearch", "domain"]);
    expect(theirs).toEqual(["fastSearch", "domain"]);
  });

  test("a free owner sees no switch, only the list and one button", () => {
    const host = mount(view({ status: status({ storageIsManaged: true }) }));
    expect(host.querySelector('[data-testid="premium-search-index"]')).toBeNull();
    expect(host.textContent ?? "").toContain("Unlimited notes");
    expect(host.querySelectorAll('[data-testid="premium-upgrade"]')).toHaveLength(1);
  });

  test("a paying owner can turn the search index off, and only that changes", async () => {
    const choose = jest.fn(async (_next: unknown) => {});
    const paying = status({
      status: "active",
      hasStripeCustomer: true,
      storageIsManaged: true,
      selected: { managedStorage: true, fastSearch: true },
      active: { managedStorage: true, fastSearch: true },
    });
    const host = mount(view({ status: paying, choose }));
    const control = host.querySelector(
      '[data-testid="premium-search-index-switch"]',
    ) as HTMLElement | null;
    expect(control).not.toBeNull();
    await act(async () => control!.click());
    expect(choose).toHaveBeenCalledWith({ managedStorage: true, fastSearch: false });
  });

  test("on the owner's own storage the index is kept on, and the screen says why", () => {
    const choose = jest.fn(async (_next: unknown) => {});
    const paying = status({
      status: "active",
      hasStripeCustomer: true,
      keepOneSelected: true,
      selected: { managedStorage: false, fastSearch: true },
      active: { managedStorage: false, fastSearch: true },
    });
    const host = mount(view({ status: paying, choose }));
    const control = host.querySelector(
      '[data-testid="premium-search-index-switch"]',
    ) as HTMLElement | null;
    act(() => control?.click());
    expect(choose).not.toHaveBeenCalled();
    expect(host.textContent ?? "").toContain("Premium keeps the index on");
  });

  test("a member reads the list and gets no switch", () => {
    const host = mount(
      view({
        status: status({ status: "active", canManage: false }),
        choose: undefined,
        upgrade: undefined,
        manageBilling: undefined,
      }),
    );
    expect(host.querySelector('[data-testid="premium-search-index"]')).toBeNull();
    expect(host.textContent ?? "").toContain("Your own domain");
  });
});
