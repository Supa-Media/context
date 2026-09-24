/**
 * @jest-environment jsdom
 *
 * Settings › Domain, mounted in every state it can be in.
 *
 * What this holds: an owner sees the records and every control, a member sees
 * the address and no control at all (absent, not disabled), a free workspace
 * gets a quiet pointer to Premium and no form, and the removal warning says
 * that nothing is deleted. The copy itself is held in `domain.test.ts`.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { DomainPanel } from "../features/console/settings/panels/DomainPanel";
import type { DomainSettings, DomainView } from "../features/console/domain/domain";
import type { DomainActions, DomainPanelView } from "../features/console/domain/useDomain";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(view: DomainPanelView, onOpenPremium?: () => void): HTMLElement {
  return mountWithRerender(view, onOpenPremium).container;
}

function mountWithRerender(view: DomainPanelView, onOpenPremium?: () => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const render = (next: DomainPanelView) =>
    act(() => {
      root.render(createElement(DomainPanel, { view: next, handle: "acme", onOpenPremium }));
    });
  render(view);
  return { container, render };
}

const actions = (): DomainActions => ({
  connect: jest.fn(async () => {}) as DomainActions["connect"],
  checkNow: jest.fn(async () => {}) as DomainActions["checkNow"],
  setHomepage: jest.fn(async () => {}) as DomainActions["setHomepage"],
  remove: jest.fn(async () => {}) as DomainActions["remove"],
});

const pending = (over: Partial<DomainView> = {}): DomainView => ({
  id: "d1",
  hostname: "docs.acme.com",
  apex: false,
  status: "pending",
  stage: "ownership",
  ownershipVerified: false,
  routingVerified: false,
  httpsReady: false,
  problem: null,
  homeSlug: null,
  checkedAt: Date.now() - 20_000,
  oneClick: null,
  records: [
    { purpose: "routing", type: "CNAME", name: "docs.acme.com", host: "docs", value: "customers.context.lc", done: false },
    {
      purpose: "ownership",
      type: "TXT",
      name: "_context.docs.acme.com",
      host: "_context.docs",
      value: "context-verification=0123456789abcdef0123456789abcdef",
      done: true,
    },
  ],
  ...over,
});

const settings = (over: Partial<DomainSettings> = {}): DomainSettings => ({
  available: true,
  paying: true,
  canManage: true,
  domain: null,
  ...over,
});

const byTest = (root: HTMLElement, id: string) => root.querySelector(`[data-testid="${id}"]`);

describe("DomainPanel", () => {
  test("an owner with Premium and no domain gets one field and one button", () => {
    const root = mount({ settings: settings(), failed: false, homepageChoices: [], actions: actions() });
    expect(byTest(root, "domain-input")).not.toBeNull();
    expect(root.textContent).toContain("Connect");
    expect(root.textContent).not.toContain("Only an owner");
  });

  test("a free workspace gets a quiet pointer to Premium, and no form", () => {
    const root = mount({ settings: settings({ paying: false }), failed: false, homepageChoices: [], actions: actions() }, () => {});
    expect(byTest(root, "domain-input")).toBeNull();
    expect(root.textContent).toContain("See Premium");
    expect(root.textContent).not.toMatch(/\$\d/);
  });

  test("while pending, an owner sees both records, the steps and Check again", () => {
    const root = mount({
      settings: settings({ domain: pending({ ownershipVerified: true }) }),
      failed: false,
      homepageChoices: [],
      actions: actions(),
    });
    expect(byTest(root, "domain-pill")?.textContent).toBe("Waiting for DNS");
    expect(byTest(root, "domain-record-routing")?.textContent).toContain("customers.context.lc");
    expect(byTest(root, "domain-record-ownership")?.textContent).toContain("Found");
    expect(byTest(root, "domain-steps")?.getAttribute("aria-label")).toBe("Step 2 of 3: connected");
    expect(root.textContent).toContain("Check again");
    expect(root.textContent).toContain("Remove");
  });

  test("a live domain shows its address and the homepage, and no records", () => {
    const root = mount({
      settings: settings({
        domain: pending({ status: "active", stage: "live", ownershipVerified: true, routingVerified: true, httpsReady: true, homeSlug: "intake" }),
      }),
      failed: false,
      homepageChoices: [{ slug: "intake", title: "Intake form" }],
      actions: actions(),
    });
    expect(byTest(root, "domain-pill")?.textContent).toBe("Live");
    expect(root.textContent).toContain("https://docs.acme.com");
    expect(root.textContent).toContain("/intake · Intake form");
    expect(byTest(root, "domain-record-routing")).toBeNull();
  });

  test("a stuck domain says what to do, in our words", () => {
    const root = mount({
      settings: settings({ domain: pending({ problem: "TIMED_OUT" }) }),
      failed: false,
      homepageChoices: [],
      actions: actions(),
    });
    expect(byTest(root, "domain-pill")?.textContent).toBe("Needs attention");
    expect(root.textContent).toContain("We stopped checking");
  });

  test("a member sees the address and status, and not one control", () => {
    const root = mount({
      settings: settings({ canManage: false, domain: pending({ records: [] }) }),
      failed: false,
      homepageChoices: [],
    });
    expect(root.textContent).toContain("docs.acme.com");
    expect(root.textContent).toContain("Being set up by an owner.");
    expect(root.textContent).toContain("Only an owner of this workspace can change its domain.");
    expect(root.querySelectorAll("button, [role=button]").length).toBe(0);
  });

  test("a paused domain promises that nothing was deleted", () => {
    const root = mount({
      settings: settings({ paying: false, domain: pending({ status: "suspended" }) }),
      failed: false,
      homepageChoices: [],
      actions: actions(),
    });
    expect(byTest(root, "domain-pill")?.textContent).toBe("Paused");
    expect(root.textContent).toContain("nothing has been deleted");
  });

  test("a deployment without domains says so and offers nothing", () => {
    const root = mount({ settings: settings({ available: false }), failed: false, homepageChoices: [], actions: actions() });
    expect(byTest(root, "domain-unavailable")).not.toBeNull();
    expect(byTest(root, "domain-input")).toBeNull();
  });

  describe("one-click setup at the DNS provider", () => {
    const oneClick = { provider: "GoDaddy", url: "https://dcc.provider.example/apply?x=1" };

    test("leads with the provider's button and folds the records away", () => {
      const root = mount({
        settings: settings({ domain: pending({ oneClick }) }),
        failed: false,
        homepageChoices: [],
        actions: actions(),
      });
      expect(byTest(root, "domain-one-click")?.textContent).toBe("Set up with GoDaddy");
      expect(root.textContent).toContain("Your DNS is at GoDaddy.");
      expect(byTest(root, "domain-record-routing")).toBeNull();
      expect(byTest(root, "domain-records-toggle")?.textContent).toContain("1 of 2 found");

      act(() => (byTest(root, "domain-records-toggle") as HTMLElement).click());
      expect(byTest(root, "domain-record-routing")).not.toBeNull();
    });

    test("a link that arrives while the records are showing does not fold them", () => {
      const { container, render } = mountWithRerender({
        settings: settings({ domain: pending() }),
        failed: false,
        homepageChoices: [],
        actions: actions(),
      });
      expect(byTest(container, "domain-record-routing")).not.toBeNull();
      render({ settings: settings({ domain: pending({ oneClick }) }), failed: false, homepageChoices: [], actions: actions() });
      expect(byTest(container, "domain-one-click")).not.toBeNull();
      expect(byTest(container, "domain-record-routing")).not.toBeNull();
    });

    test("a stuck domain shows its records, whatever the provider offers", () => {
      const root = mount({
        settings: settings({ domain: pending({ oneClick, problem: "TIMED_OUT" }) }),
        failed: false,
        homepageChoices: [],
        actions: actions(),
      });
      expect(byTest(root, "domain-record-routing")).not.toBeNull();
    });

    test("once both records are found, the button and the records are gone", () => {
      const root = mount({
        settings: settings({
          domain: pending({ oneClick, ownershipVerified: true, routingVerified: true, stage: "https" }),
        }),
        failed: false,
        homepageChoices: [],
        actions: actions(),
      });
      expect(byTest(root, "domain-one-click")).toBeNull();
      expect(byTest(root, "domain-records-toggle")).toBeNull();
      expect(root.textContent).toContain("Both records found.");
    });
  });
});
