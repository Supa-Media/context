/**
 * @jest-environment jsdom
 */

/**
 * The console's Tex tab, actually rendered.
 *
 *  1. **Its figures reach the screen** from `texReport`: texts handled,
 *     spend, the scorecard and what frustrates people.
 *  2. **The window reaches the query.**
 *  3. **Explore's filters are dropdowns that narrow the table**: picking a
 *     task in the Task menu leaves only its rows, and Clear brings them back.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * Sabotage record (temporary local edits, reverted, 2026-10-24):
 *
 *   `Console` not rendering `TexSection` for the tex tab            3
 *   `applyFilters` ignoring the filters                             1
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
const mockArgs = new Map<string, unknown>();

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      mockArgs.set(name, args);
      return mockAnswers.get(name);
    },
    useQueries: () => ({}),
    useAction: () => async () => {
      throw new Error("not used in this test");
    },
    useMutation: () => async () => {
      throw new Error("not used in this test");
    },
  };
});

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, back: () => {} }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AdminPane } from "../features/admin/AdminPane";

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
  mockArgs.clear();
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
    root.render(createElement(AdminPane));
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

function review(over: Record<string, unknown> = {}) {
  return {
    at: Date.now() - 60_000,
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
    days: 30,
    turnDays: 30,
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
      tools: [{ tool: "browse", calls: 10, failed: 2 }],
    },
    reviewsTruncated: false,
    reviews: [
      review(),
      review({ task: "web_errand", signals: ["try_again"], calm: 3 }),
      review({ task: "web_errand", calm: 4, kind: "group" }),
      review({ task: "calendar" }),
    ],
  };
}

function onTexTab(): HTMLElement {
  mockAnswers.set("functions/admin:amIAdmin", true);
  mockAnswers.set("functions/admin:listSecrets", []);
  mockAnswers.set(TEX, report());
  const container = mount();
  click("admin-tab-tex");
  return container;
}

describe("the Tex tab", () => {
  test("its figures reach the screen", () => {
    onTexTab();
    expect(find("admin-tex")).not.toBeNull();
    expect(find("admin-tex-texts")?.textContent).toContain("12");
    expect(find("admin-tex-spend")?.textContent).toContain("$3.20");
    expect(find("admin-tex-scored")?.textContent).toContain("4");
    expect(find("admin-tex-frustrated")?.textContent).toContain("50%");
    expect(find("admin-tex-by-task")?.textContent).toMatch(/Web errands \(2\).*100%/);
    expect(find("admin-tex-models")?.textContent).toContain("Think-model");
    expect(find("admin-tex-tools")?.textContent).toContain("20% failed");
  });

  test("the window reaches the query", () => {
    onTexTab();
    expect(mockArgs.get(TEX)).toEqual({ days: 30 });
    click("admin-tex-days-7");
    expect(mockArgs.get(TEX)).toEqual({ days: 7 });
  });

  test("a task picked from the Task dropdown narrows the table, and Clear brings it back", () => {
    onTexTab();
    expect(find("admin-tex-table")?.textContent).toContain("Email");
    click("admin-tex-filter-task");
    click("menu-item-web_errand");
    expect(find("admin-tex-filter-task")?.textContent).toContain("Task: Web errands");
    expect(find("admin-tex-table")?.textContent).toContain("Web errands");
    expect(find("admin-tex-table")?.textContent).not.toContain("Email");
    expect(find("admin-tex-explore")?.textContent).toContain("2 of 4 conversations");
    click("admin-tex-clear");
    expect(find("admin-tex-table")?.textContent).toContain("Email");
  });
});
