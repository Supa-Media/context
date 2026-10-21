/**
 * @jest-environment jsdom
 */

/**
 * The console's Usage tab, actually rendered, and the words it is drawn with.
 *
 *  1. **The figures reach the screen**: a card per site, time in app, and the
 *     pages and buttons with their plain names over the route or fixed id.
 *  2. **Every state says what it is**: loading, PostHog not connected, PostHog
 *     refusing, and a window with nothing in it.
 *  3. **No change is claimed against a window nobody measured.**
 *  4. **A phone shows five rows and "Show all"**.
 *  5. **The tab is wired** into the console.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { ReactElement } from "react";
import type { UsageAnalytics } from "@context/convex/functions/lib/adminFns/usageAnalyticsShape";

jest.mock("convex/react", () => ({
  useQuery: () => undefined,
  useQueries: () => ({}),
  useAction: () => async () => ({ connected: false }),
  useMutation: () => async () => {
    throw new Error("not used in this test");
  },
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, back: () => {} }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { UsageView } from "../features/admin/UsageSection";
import { ADMIN_TABS } from "../features/admin/report";
import { isWindowed } from "../features/admin/ConsoleHeader";
import {
  busiestDay,
  buttonLabel,
  comparison,
  durationComparison,
  formatDuration,
  formatHours,
  formatSignedDuration,
  pageLabel,
  perEach,
  shares,
} from "../features/admin/usage";

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function setWidth(px: number): void {
  Object.defineProperty(document.documentElement, "clientWidth", { value: px, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: px, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(element);
  });
  return container;
}

function find(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

const days = (counts: number[]) =>
  counts.map((count, index) => ({ day: `2026-10-${String(15 + index).padStart(2, "0")}`, count }));

function usage(over: Partial<Extract<UsageAnalytics, { error: null }>> = {}): UsageAnalytics {
  return {
    connected: true,
    error: null,
    days: 7,
    sites: [
      { host: "context.lc", visits: 31, visitors: 12, priorVisits: 20, priorVisitors: 13, daily: days([1, 4, 0, 6, 8, 5, 7]) },
      { host: "tex.lc", visits: 9, visitors: 6, priorVisits: 0, priorVisitors: 0, daily: days([0, 0, 2, 0, 3, 4, 0]) },
    ],
    time: { sessions: 40, people: 12, medianSeconds: 250, averageSeconds: 452, totalSeconds: 18_090 },
    priorTime: { sessions: 30, people: 10, medianSeconds: 212, averageSeconds: 430, totalSeconds: 9_000 },
    pages: [
      { route: "/console/:context", views: 90, people: 10 },
      { route: "/note/:context/:value", views: 60, people: 8 },
      { route: "/", views: 30, people: 20 },
      { route: "/tex/:context", views: 10, people: 3 },
      { route: "/console/search", views: 8, people: 4 },
      { route: "/console/map", views: 4, people: 2 },
    ],
    buttons: [
      { button: "new_note", clicks: 12, people: 4 },
      { button: "share_note", clicks: 2, people: 2 },
    ],
    ...over,
  };
}

describe("the words and figures", () => {
  test("durations, signed durations and hours", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(250)).toBe("4m 10s");
    expect(formatDuration(7_500)).toBe("2h 5m");
    expect(formatSignedDuration(38)).toBe("+38s");
    expect(formatSignedDuration(-65)).toBe("−1m 5s");
    expect(formatSignedDuration(0)).toBe("±0s");
    expect(formatHours(18_090)).toBe("5");
    expect(formatHours(600)).toBe("<1");
    expect(formatHours(0)).toBe("0");
  });

  test("no change is claimed against a window nobody measured", () => {
    expect(comparison(31, 20, 30)).toEqual({ change: 11, words: "on the 30 before" });
    expect(comparison(9, 0, 30)).toEqual({ change: null, words: "none in the 30 before" });
    expect(comparison(0, 0, 30)).toEqual({ change: null, words: "nothing yet" });
    expect(durationComparison(250, null, 30).change).toBeNull();
    expect(durationComparison(250, 0, 30).words).toBe("nothing to compare yet");
    expect(durationComparison(250, 212, 30)).toEqual({ change: "+38s", up: true, words: "on the 30 before" });
  });

  test("names: a known route or button reads plainly, anything else as itself", () => {
    expect(pageLabel("/console/:context")).toBe("Workspace");
    expect(pageLabel("/console/brandnew")).toBe("/console/brandnew");
    expect(buttonLabel("share_note")).toBe("Share");
    expect(buttonLabel("not_a_button")).toBe("not_a_button");
  });

  test("busiest day, visits each, and the share bars", () => {
    expect(busiestDay(days([1, 4, 0, 6, 8, 5, 7]))).toEqual({ count: 8, day: expect.any(String) });
    expect(busiestDay(days([0, 0]))).toBeNull();
    expect(perEach(31, 12)).toBe("2.6");
    expect(perEach(5, 0)).toBe("—");
    expect(shares([90, 45, 0])).toEqual([1, 0.5, 0]);
    expect(shares([])).toEqual([]);
  });
});

describe("the tab", () => {
  test("sits after Activity and uses the window picker", () => {
    const keys = ADMIN_TABS.map((tab) => tab.key);
    expect(keys.indexOf("usage")).toBe(keys.indexOf("activity") + 1);
    expect(isWindowed("usage")).toBe(true);
  });

  test("draws a card per site, time in app, pages and buttons", () => {
    setWidth(1280);
    const page = mount(createElement(UsageView, { usage: usage(), days: 7 }));
    expect(find("admin-usage-site-context.lc")?.textContent).toContain("31");
    expect(find("admin-usage-site-context.lc")?.textContent).toContain("+11");
    // tex.lc's window before measured nothing, so no change is printed for it.
    expect(find("admin-usage-site-tex.lc")?.textContent).toContain("none in the 7 before");
    expect(find("admin-usage-time")?.textContent).toContain("4m 10s");
    expect(find("admin-usage-time")?.textContent).toContain("+38s");
    expect(find("admin-usage-page-/console/:context")?.textContent).toContain("Workspace");
    expect(find("admin-usage-button-share_note")?.textContent).toContain("Share");
    expect(page.textContent).toContain("people who turned off screen counts are not in these figures");
    expect(page.textContent).toContain("12 people active");
    expect(page.textContent).not.toContain("people signed in");
  });

  test("a phone shows five pages and offers the rest", () => {
    setWidth(390);
    mount(createElement(UsageView, { usage: usage(), days: 7 }));
    expect(find("admin-usage-page-/console/map")).toBeNull();
    const all = find("admin-usage-pages-all");
    expect(all?.textContent).toBe("Show all 6");
    act(() => all!.click());
    expect(find("admin-usage-page-/console/map")).not.toBeNull();
  });

  test("every state says what it is", () => {
    setWidth(1280);
    mount(createElement(UsageView, { usage: undefined, days: 7 }));
    expect(find("admin-usage-loading")).not.toBeNull();
    document.body.innerHTML = "";

    mount(createElement(UsageView, { usage: { connected: false }, days: 7 }));
    expect(find("admin-usage-unset")?.textContent).toContain("POSTHOG_PERSONAL_API_KEY");

    mount(createElement(UsageView, { usage: { connected: true, error: "PostHog answered 500" }, days: 7 }));
    expect(find("admin-usage-error")?.textContent).toContain("PostHog answered 500");

    mount(
      createElement(UsageView, {
        usage: usage({
          sites: [{ host: "tex.lc", visits: 0, visitors: 0, priorVisits: 0, priorVisitors: 0, daily: days([0, 0, 0]) }],
          time: null,
          priorTime: null,
          pages: [],
          buttons: [],
        }),
        days: 7,
      }),
    );
    expect(find("admin-usage-buttons")?.textContent).toContain("No clicks yet");
    expect(find("admin-usage-time")?.textContent).toContain("nobody yet");
    expect(find("admin-usage-site-tex.lc")?.textContent).toContain("No visits yet");
    expect(find("admin-usage-site-tex.lc")?.textContent).toContain("nothing yet");
  });
});

describe("conversion and drop-off", () => {
  test("shows ordered funnel people, conversion and the gap at each step", () => {
    setWidth(1280);
    mount(createElement(UsageView, { days: 7, usage: usage({
      funnels: [{ id: "tex_waitlist", steps: [
        { key: "landing", people: 100 }, { key: "signup_started", people: 50 },
        { key: "signup_submitted", people: 40 }, { key: "waitlist_joined", people: 25 },
      ] }],
      outcomes: [{ event: "signin_code_result", result: "failed", attempts: 6, people: 3 }],
    }) }));
    expect(find("admin-usage-funnel-tex_waitlist")?.textContent).toContain("Tex waitlist");
    expect(find("admin-usage-funnel-tex_waitlist-waitlist_joined")?.textContent).toContain("25%");
    expect(find("admin-usage-funnel-tex_waitlist-waitlist_joined")?.textContent).toContain("15 not yet progressed");
    expect(find("admin-usage-outcomes")?.textContent).toContain("Sign-in code");
    expect(find("admin-usage-outcomes")?.textContent).toContain("Outcome");
    expect(find("admin-usage-outcomes")?.textContent).toContain("6");
  });
  test("an unmeasured funnel has an empty state, not a zero-percent conversion claim", () => {
    setWidth(390);
    const page = mount(createElement(UsageView, { days: 7, usage: usage({
      funnels: [{ id: "tex_signin", steps: [
        { key: "code_sent", people: 0 }, { key: "code_submitted", people: 0 }, { key: "signed_in", people: 0 },
      ] }],
    }) }));
    expect(find("admin-usage-funnel-tex_signin")?.textContent).toContain("No funnel events yet");
    expect(find("admin-usage-funnel-tex_signin")?.textContent).not.toContain("0%");
    expect(page.textContent).not.toContain("NaN");
  });
});
