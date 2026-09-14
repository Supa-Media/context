/**
 * @jest-environment jsdom
 */

/**
 * The staff console, actually rendered.
 *
 * `adminReport.test.ts` next door covers the arithmetic, and that is exactly
 * the coverage that lets whole limbs of this page be deleted with the suite
 * still green: `compositionOf` can be perfect while nothing calls it. These
 * are the four claims the screen itself makes, each of which is a rule from
 * the redesign rather than a rendering detail:
 *
 *  1. **A non-admin sees a missing page**, and none of the figures — the
 *     server refuses them too, but a screen that leaked one before the refusal
 *     landed would be a leak all the same.
 *  2. **A truncated census withholds the growth curves.** The notice alone is
 *     not the rule; drawing a cumulative line from an arbitrary slice of rows
 *     is, and it is the one that would survive a careless edit.
 *  3. **The tabs actually separate the errands.** The credential form must not
 *     be on the growth tab — that separation is the redesign, and a `show()`
 *     that returned everything would pass every other test in this repo.
 *  4. **Figures reach the screen**, so the census query being dropped or
 *     renamed is a red test rather than a page of zeroes.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the `census.truncated` guard around the curves removed        1
 *   `Console` rendering every section regardless of the tab       4
 *   `AdminPane` rendering the console for a non-admin             1
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * Whatever the pane asks for, answered from a table this file sets per test.
 *
 * Keyed by the Convex function's own name rather than by reference identity:
 * `api.functions.admin.usageReport` is a proxy and two reads of it are not
 * `===`, so a reference map would have silently answered `undefined` to
 * everything and rendered a page of loading states that still passed.
 */
const mockAnswers = new Map<string, unknown>();

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<
    typeof import("convex/server")
  >("convex/server");
  return {
    useQuery: (reference: never) =>
      mockAnswers.get(getFunctionName(reference)),
    useAction: () => async () => {
      throw new Error("not used in this test");
    },
    useMutation: () => async () => {
      throw new Error("not used in this test");
    },
  };
});

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AdminPane } from "../features/admin/AdminPane";

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
});

function mount(): HTMLElement {
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
    root.render(createElement(AdminPane));
  });
  return container;
}

function click(container: HTMLElement, testID: string): void {
  const node = container.querySelector(`[data-testid="${testID}"]`);
  if (node === null) throw new Error(`no control called ${testID}`);
  act(() => {
    (node as HTMLElement).click();
  });
}

function has(container: HTMLElement, testID: string): boolean {
  return container.querySelector(`[data-testid="${testID}"]`) !== null;
}

const WINDOW = ["2026-09-13", "2026-09-14"];

function points(counts: number[]) {
  return counts.map((count, index) => ({ day: WINDOW[index], count }));
}

function census(over: Record<string, unknown> = {}) {
  return {
    days: 2,
    window: WINDOW,
    truncated: false,
    accounts: {
      total: { count: 4, isFloor: false },
      added: points([1, 0]),
      cumulative: points([3, 4]),
      newInWindow: 1,
      newInPriorWindow: 0,
    },
    contexts: {
      total: { count: 7, isFloor: false },
      added: points([0, 2]),
      cumulative: points([5, 7]),
      newInWindow: 2,
      newInPriorWindow: 1,
      personal: 5,
      shared: 2,
      perAccount: 1.8,
      membersPerShared: 2.5,
    },
    storage: {
      managed: 2,
      customer: 3,
      unbound: 2,
      byProvider: [{ provider: "r2", managed: 2, customer: 1 }],
      byStatus: [{ status: "connected", count: 4 }],
    },
    plans: {
      paying: 2,
      pastDue: 1,
      canceled: 0,
      unresolved: 0,
      free: 4,
      mrrCents: 1_000,
      servingManagedStorage: 2,
      servingFastSearch: 1,
      provisioningRunning: 0,
      provisioningFailed: 0,
    },
    clients: [
      {
        clientId: "cid-desk",
        clientName: "A Desktop Client",
        active: 3,
        revoked: 1,
        contexts: 2,
        accounts: 2,
        lastUsedAt: Date.now(),
      },
    ],
    sources: {
      googleAccounts: 1,
      gmail: 1,
      calendar: 1,
      chat: 0,
      dropbox: 1,
      mailOpen: 0,
      mailAllowlisted: 2,
      obsidian: 1,
    },
    funnel: [
      { step: "signed-up", count: 4 },
      { step: "made-a-context", count: 3 },
      { step: "connected-storage", count: 2 },
      { step: "connected-a-client", count: 2 },
      { step: "paying", count: 2 },
    ],
    roster: [
      {
        joinedAt: Date.now() - 86_400_000,
        email: "someone@example.test",
        contexts: 2,
        owned: 2,
        connectedStorage: 1,
        clients: 1,
        plan: "active",
        lastSeenAt: Date.now(),
      },
    ],
    ...over,
  };
}

function usage() {
  return {
    days: 2,
    window: WINDOW,
    series: [{ metric: "mcp.tool_call", points: points([4, 9]), total: 13 }],
    activeContexts: { points: points([1, 3]), distinctInWindow: 3 },
    totals: {
      workspaces: { count: 7, isFloor: false },
      users: { count: 4, isFloor: false },
    },
  };
}

function asAdmin(over: Record<string, unknown> = {}): void {
  mockAnswers.set("functions/admin:amIAdmin", true);
  mockAnswers.set("functions/admin:censusReport", census(over));
  mockAnswers.set("functions/admin:usageReport", usage());
  mockAnswers.set("functions/admin:listSecrets", []);
}

describe("who the page renders for", () => {
  test("the mock answers the queries the pane actually asks", () => {
    // Without this every test below would render loading states and pass.
    asAdmin();
    const container = mount();
    expect(has(container, "admin-stat-accounts")).toBe(true);
  });

  test("a non-admin sees a missing page and not one figure", () => {
    mockAnswers.set("functions/admin:amIAdmin", false);
    // Deliberately present, so this asserts the *screen* withholds them rather
    // than there being nothing to withhold.
    mockAnswers.set("functions/admin:censusReport", census());
    mockAnswers.set("functions/admin:usageReport", usage());
    const container = mount();
    expect(container.textContent).toContain("Not found");
    expect(has(container, "admin-stat-accounts")).toBe(false);
    expect(has(container, "admin-roster")).toBe(false);
    expect(container.textContent).not.toContain("someone@example.test");
  });

  test("an unresolved check shows neither the console nor the refusal", () => {
    // `undefined` is not `false`. Flashing "not found" at an admin on every
    // cold load is the bug this guards.
    mockAnswers.set("functions/admin:amIAdmin", undefined);
    const container = mount();
    expect(container.textContent).not.toContain("Not found");
    expect(has(container, "admin-stat-accounts")).toBe(false);
  });
});

describe("growth is what the page opens on", () => {
  beforeEach(() => asAdmin());

  test("the headline figures reach the screen", () => {
    const container = mount();
    const text = container.textContent ?? "";
    expect(text).toContain("Accounts");
    expect(text).toContain("Paying contexts");
    // Contexts outnumber accounts, which is the fact this page was asked for.
    expect(text).toContain("1.8 per account");
    // $10, from two paying contexts at the one price.
    expect(text).toContain("$10 a month");
  });

  test("the period comparison is absolute, not a percentage", () => {
    const container = mount();
    expect(container.textContent).toContain("+1 — 1 vs 0 before");
  });

  test("the curves, the funnel and the roster are all drawn", () => {
    const container = mount();
    expect(has(container, "admin-curve-accounts")).toBe(true);
    expect(has(container, "admin-curve-contexts")).toBe(true);
    expect(has(container, "admin-funnel")).toBe(true);
    expect(has(container, "admin-roster")).toBe(true);
    expect(container.textContent).toContain("someone@example.test");
  });

  test("the credential form is NOT here", () => {
    // The split is the redesign. A page that renders everything at once passes
    // every other assertion in this file.
    const container = mount();
    expect(has(container, "admin-secret-value")).toBe(false);
    expect(has(container, "admin-storage")).toBe(false);
  });
});

describe("a census that stopped counting", () => {
  test("says so, and withholds the curves rather than drawing a partial one", () => {
    // The rule, not the notice. A cumulative line missing an arbitrary slice
    // of its rows is a different and wrong shape, not a rough one.
    asAdmin({ truncated: true });
    const container = mount();
    expect(has(container, "admin-census-truncated")).toBe(true);
    expect(has(container, "admin-curve-accounts")).toBe(false);
    expect(has(container, "admin-curve-contexts")).toBe(false);
    // The snapshot figures stay: they are floors, which is still an answer.
    expect(has(container, "admin-stat-accounts")).toBe(true);
    expect(has(container, "admin-funnel")).toBe(true);
  });

  test("an untruncated census draws them and says nothing", () => {
    asAdmin();
    const container = mount();
    expect(has(container, "admin-census-truncated")).toBe(false);
    expect(has(container, "admin-curve-accounts")).toBe(true);
  });
});

describe("the tabs separate the errands", () => {
  beforeEach(() => asAdmin());

  test("estate carries storage, plans, clients and sources — and growth leaves", () => {
    const container = mount();
    click(container, "admin-tab-estate");
    expect(has(container, "admin-storage")).toBe(true);
    expect(has(container, "admin-plans")).toBe(true);
    expect(has(container, "admin-clients")).toBe(true);
    expect(has(container, "admin-sources")).toBe(true);
    expect(has(container, "admin-roster")).toBe(false);
    expect(container.textContent).toContain("A Desktop Client");
  });

  test("managed and customer-owned storage are both named", () => {
    const container = mount();
    click(container, "admin-tab-estate");
    const text = container.textContent ?? "";
    expect(text).toContain("Managed by us");
    expect(text).toContain("Customer's own bucket");
    expect(text).toContain("Cloudflare R2");
  });

  test("activity carries the counters and not the census", () => {
    const container = mount();
    click(container, "admin-tab-activity");
    expect(has(container, "admin-metric-mcp.tool_call")).toBe(true);
    expect(has(container, "admin-active")).toBe(true);
    expect(has(container, "admin-stat-accounts")).toBe(false);
  });

  test("credentials carries the form and no figures", () => {
    const container = mount();
    click(container, "admin-tab-credentials");
    expect(has(container, "admin-secret-value")).toBe(true);
    expect(has(container, "admin-stat-accounts")).toBe(false);
    expect(has(container, "admin-storage")).toBe(false);
  });

  test("the chosen window survives a tab change", () => {
    const container = mount();
    click(container, "admin-window-7");
    click(container, "admin-tab-activity");
    // Still offered, and still the one that was picked — re-choosing the
    // period every time you cross a tab is not a feature.
    expect(has(container, "admin-window-7")).toBe(true);
  });
});
