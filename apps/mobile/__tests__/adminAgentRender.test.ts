/**
 * @jest-environment jsdom
 */

/**
 * The console's Agent tab, actually rendered.
 *
 *  1. **Its figures reach the screen** from `agentReport`, so the query being
 *     renamed or dropped is a red test rather than a tab of loading states.
 *  2. **A recent question opens step by step and comes back**, with the
 *     slowest step named against that lookup's typical time.
 *  3. **The filters reach the query**: the client and the window are
 *     arguments, not decoration over one fixed answer.
 *  4. **A workspace that does not exist says so** rather than drawing zeroes
 *     as if it were a quiet one.
 *
 * Sabotage record (temporary local edits, reverted):
 *
 *   `Console` not rendering `AgentSection` for the agent tab        5
 *   the client segment not passed to the query                      1
 *   `onBack` not clearing the open question                         1
 *   the not-found note never drawn                                  1
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

const AGENT = "functions/admin:agentReport";

function report(over: Record<string, unknown> = {}) {
  return {
    days: 7,
    client: "all",
    workspace: null,
    truncated: false,
    current: {
      turns: 12,
      workspaces: 3,
      p50: 4_200,
      p95: 11_000,
      answered: 10,
      exhausted: 1,
      failed: 1,
      totalMs: 60_000,
      modelMs: 36_000,
      toolMs: 18_000,
      toolCalls: 20,
    },
    prior: { turns: 8, p50: 4_800, p95: 9_000 },
    buckets: [
      { label: "2026-10-06", turns: 5, p50: 4_000, p95: 9_000 },
      { label: "2026-10-07", turns: 7, p50: 4_400, p95: 11_000 },
    ],
    models: [{ provider: "builtin", model: "a-test-model", turns: 12, p50: 4_200 }],
    tools: [
      { tool: "search_notes", calls: 14, failed: 0, p50: 300, p95: 900 },
      { tool: "search_web", calls: 6, failed: 1, p50: 1_000, p95: 2_500 },
    ],
    recent: [
      {
        id: "turn-1",
        at: Date.now() - 60_000,
        workspace: "maya",
        client: "texts",
        provider: "builtin",
        model: "a-test-model",
        outcome: "answered",
        rounds: 2,
        ms: 6_000,
        modelMs: 2_500,
        toolMs: 3_200,
        inputTokens: 900,
        outputTokens: 80,
        trace: [
          { kind: "model", ok: true, ms: 1_200 },
          { kind: "tool", tool: "search_web", ok: true, ms: 3_000 },
          { kind: "tool", tool: "search_notes", ok: true, ms: 200 },
          { kind: "model", ok: true, ms: 1_300 },
        ],
      },
    ],
    ...over,
  };
}

function onAgentTab(over: Record<string, unknown> = {}): HTMLElement {
  mockAnswers.set("functions/admin:amIAdmin", true);
  mockAnswers.set("functions/admin:listSecrets", []);
  mockAnswers.set(AGENT, report(over));
  const container = mount();
  click("admin-tab-agent");
  return container;
}

describe("the Agent tab", () => {
  test("its figures reach the screen", () => {
    const container = onAgentTab();
    expect(find("admin-agent")).not.toBeNull();
    expect(find("admin-agent-p50")?.textContent).toContain("4.2 s");
    expect(find("admin-agent-p50")?.textContent).toContain("0.6 s faster than the 7 days before");
    expect(find("admin-agent-p95")?.textContent).toContain("2.0 s slower");
    expect(find("admin-agent-turns")?.textContent).toContain("+4 vs the 7 days before");
    expect(find("admin-agent-endings")?.textContent).toContain("83%");
    expect(find("admin-agent-tool-search_web")?.textContent).toContain("Search the web");
    expect(find("admin-agent-chart")).not.toBeNull();
    expect(container.textContent).toContain("@maya");
    expect(container.textContent).toContain("Turns are kept for 30 days");
  });

  test("a recent question opens step by step and comes back", () => {
    onAgentTab();
    click("admin-agent-turn-turn-1");
    expect(find("admin-agent-detail")).not.toBeNull();
    expect(find("admin-agent-slowest")?.textContent).toBe("Search the web took 3.0 s here, about 3× its typical 1.0 s.");
    expect(find("admin-agent-step-3")).not.toBeNull();
    expect(find("admin-agent-outcome")?.textContent).toBe("Answered");
    click("admin-agent-back");
    expect(find("admin-agent-detail")).toBeNull();
    expect(find("admin-agent-recent")).not.toBeNull();
  });

  test("the client and the window reach the query", () => {
    onAgentTab();
    expect(mockArgs.get(AGENT)).toEqual({ days: 7, client: "all" });
    click("admin-agent-client-texts");
    click("admin-agent-days-30");
    expect(mockArgs.get(AGENT)).toEqual({ days: 30, client: "texts" });
  });

  test("a workspace that does not exist says so, rather than drawing zeroes", () => {
    onAgentTab({ current: { ...report().current, turns: 0 }, recent: [] });
    const input = find("admin-agent-workspace") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, "@nobody");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(mockArgs.get(AGENT)).toEqual({ days: 7, client: "all", workspace: "@nobody" });
    expect(document.body.textContent).toContain("No workspace called @nobody");
  });

  test("an empty window says so", () => {
    const container = onAgentTab({
      current: { ...report().current, turns: 0 },
      recent: [],
    });
    expect(container.textContent).toContain("No questions in this window");
    expect(find("admin-agent-p50")).toBeNull();
  });
});
