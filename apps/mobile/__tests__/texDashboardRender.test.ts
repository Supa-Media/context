/**
 * @jest-environment jsdom
 */

/**
 * tex.lc/admin, actually rendered: the Tex dashboard is a page of its own, not
 * a tab in the staff console (the owner, 2026-10-24).
 *
 *  1. **The host decides.** `/admin` on tex.lc draws the dashboard; on
 *     context.lc it is still the console's redirect to Growth.
 *  2. **Its figures reach the screen** from `texReport`: texts, spend, answer
 *     time, frustration, the model cards, tasks, tools and what needs a look.
 *  3. **The window reaches the query.**
 *  4. **Explore's filters are dropdowns that narrow the table**, and a task
 *     card filters Explore to that task.
 *  5. **Somebody who is not staff sees "Staff only"**, and the report is
 *     never asked for.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * Sabotage record (temporary local edits, reverted, 2026-10-24):
 *
 *   `AdminRoute` ignoring the host (always redirecting)             6
 *   `applyFilters` ignoring the filters                             2
 *   `texReport` asked without the staff check ("skip" removed)      1
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
const mockArgs = new Map<string, unknown>();
let mockTexHost = true;

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      mockArgs.set(name, args);
      return args === "skip" ? undefined : mockAnswers.get(name);
    },
  };
});

jest.mock("expo-router", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return { Redirect: ({ href }: { href: string }) => createElement("div", { "data-testid": "redirect", "data-href": href }) };
});

jest.mock("../features/site/host", () => ({ isTexHost: () => mockTexHost }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import AdminRoute from "../app/(app)/admin/index";

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
  mockArgs.clear();
  mockTexHost = true;
});

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(AdminRoute));
  });
  return container;
}

function find(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function click(testID: string): void {
  const node = find(testID);
  if (node === null) throw new Error(`no control called ${testID}`);
  act(() => {
    node.click();
  });
}

const TEX = "functions/admin:texReport";
const ADMIN = "functions/admin:amIAdmin";

function review(over: Record<string, unknown> = {}) {
  return {
    at: Date.parse("2026-10-24T12:00:00Z"),
    kind: "one",
    reason: "ended",
    goal: 8,
    independence: 8,
    turns: 8,
    friendly: 8,
    calm: 9,
    task: "email",
    signals: [],
    texts: 2,
    who: "other",
    costMicroUsd: 1_000,
    thought: false,
    ...over,
  };
}

function report() {
  return {
    days: 7,
    turnDays: 2,
    turns: {
      truncated: false,
      total: 14,
      byKind: { one: 9, group: 3, job: 1, routine: 1, app: 0, older: 0 },
      answered: 12,
      exhausted: 1,
      failed: 1,
      costMicroUsd: 3_200_000,
      priced: 14,
      byDay: [
        { day: "2026-10-23", turns: 6, costMicroUsd: 1_000_000 },
        { day: "2026-10-24", turns: 8, costMicroUsd: 2_200_000 },
      ],
      models: [{ model: "fake-provider/think-model", turns: 4, inputTokens: 12_000, outputTokens: 2_000, cacheReadTokens: 0, costMicroUsd: 3_000_000 }],
      tools: [{ tool: "browse", calls: 10, failed: 3 }],
    },
    performance: {
      time: { totalMs: 140_000, modelMs: 90_000, toolMs: 30_000, p50: 4_200, p95: 75_000 },
      models: [{ model: "fake-provider/think-model", rounds: 20, failed: 2, retried: 1, cut: 0, fallbacks: 1, p50: 3_000, p95: 9_000 }],
      router: { picks: 10, think: 3, confidence: 0.8 },
      daily: [
        { p50: 4_000, p95: 70_000 },
        { p50: 4_400, p95: 80_000 },
      ],
      tools: [{ tool: "browse", p50: 6_000 }],
    },
    reviewsTruncated: false,
    reviews: [
      review(),
      review({ task: "web_errand", signals: ["try_again"], calm: 3, texts: 6 }),
      review({ task: "web_errand", calm: 4, kind: "group" }),
      review({ task: "web_errand", calm: 2 }),
      review({ task: "calendar" }),
    ],
  };
}

function asStaff(): HTMLElement {
  mockAnswers.set(ADMIN, true);
  mockAnswers.set(TEX, report());
  return mount();
}

describe("tex.lc/admin", () => {
  test("is the dashboard on tex.lc, and still the console's redirect on context.lc", () => {
    asStaff();
    expect(find("tex-dashboard")).not.toBeNull();
    expect(find("redirect")).toBeNull();
    roots.pop()!();
    mockTexHost = false;
    mount();
    expect(find("tex-dashboard")).toBeNull();
    expect(find("redirect")?.getAttribute("data-href")).toBe("/admin/growth");
  });

  test("its figures reach the screen", () => {
    asStaff();
    expect(find("tex-dashboard-kpi-texts")?.textContent).toContain("12");
    expect(find("tex-dashboard-kpi-spend")?.textContent).toContain("$3.20");
    expect(find("tex-dashboard-kpi-speed")?.textContent).toContain("4.2s");
    expect(find("tex-dashboard-kpi-frustrated")?.textContent).toContain("60%");
    expect(find("tex-dashboard-models")?.textContent).toContain("Think-model");
    expect(find("tex-dashboard-models")?.textContent).toContain("Router sent 30% to thinking");
    expect(find("tex-dashboard-models")?.textContent).toMatch(/Errors \/ retried10% \/ 5%/);
    expect(find("tex-dashboard-task-web_errand")?.textContent).toContain("Web errands");
    expect(find("tex-dashboard-tools")?.textContent).toContain("browse");
    expect(find("tex-dashboard-look")?.textContent).toContain("Web errands: 100% of 3 conversations frustrated people");
    expect(find("tex-dashboard-look")?.textContent).toContain("Think-model failed 10% of its rounds");
  });

  test("the window reaches the query", () => {
    asStaff();
    expect(mockArgs.get(TEX)).toEqual({ days: 7 });
    click("tex-dashboard-days-30");
    expect(mockArgs.get(TEX)).toEqual({ days: 30 });
  });

  test("a task picked from the Task dropdown narrows the table, and Clear brings it back", () => {
    asStaff();
    expect(find("tex-dashboard-table")?.textContent).toContain("Email");
    click("tex-dashboard-filter-task");
    click("tex-dashboard-filter-task-web_errand");
    expect(find("tex-dashboard-filter-task")?.textContent).toContain("Web errands");
    expect(find("tex-dashboard-table")?.textContent).not.toContain("Email");
    expect(find("tex-dashboard-explore-count")?.textContent).toContain("3 of 5 conversations");
    click("tex-dashboard-clear");
    expect(find("tex-dashboard-table")?.textContent).toContain("Email");
  });

  test("a task card filters Explore to that task", () => {
    asStaff();
    Element.prototype.scrollIntoView = () => {};
    click("tex-dashboard-task-calendar");
    expect(find("tex-dashboard-explore-count")?.textContent).toContain("1 of 5 conversations");
  });

  test("somebody who is not staff sees Staff only, and the report is never asked for", () => {
    mockAnswers.set(ADMIN, false);
    mockAnswers.set(TEX, report());
    mount();
    expect(find("tex-dashboard-staff-only")?.textContent).toContain("Staff only");
    expect(mockArgs.get(TEX)).toBe("skip");
    expect(find("tex-dashboard-kpi-texts")).toBeNull();
  });
});
