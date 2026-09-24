/**
 * @jest-environment jsdom
 */

/**
 * AGENTS IN THE COLUMN, ON THE GLASS.
 *
 * `agentActivityView.test.ts` proves the rules; this proves the explorer is
 * wired to them, and the claims only a rendered column can make:
 *
 *  1. **No agents, no line.** The foot is the counts line, exactly as before.
 *  2. **Many agents, one line.** The sidebar does not grow with the number of
 *     agents; who they are is in the list the line opens.
 *  3. **A closed folder carries the square for what is under it**, and says
 *     so in words, because a mark only sighted people get is not a mark.
 *  4. **A row in the list opens the note it is about**, through the same
 *     `select` the tree uses.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context";
import { Explorer } from "../features/console/files/Explorer";
import type { FileBrowser } from "../features/console/files/browser";
import type { AgentActivityView } from "../features/console/agents/agentActivity";

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 1280, height: 900 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

const ROOT_LISTING = {
  path: "",
  entries: [
    {
      name: "1-projects",
      path: "1-projects",
      kind: "folder" as const,
      visibility: "team",
      inherited: "team",
      exception: false,
      readOnly: false,
    },
    {
      name: "index.md",
      path: "index.md",
      kind: "file" as const,
      visibility: "team",
      inherited: "team",
      exception: false,
      readOnly: false,
    },
  ],
  manifestUsable: true,
  truncated: false,
};

const noop = () => {};

function browser(over: Partial<FileBrowser> = {}): FileBrowser {
  const base = {
    canEdit: true,
    submitForm: async () => ({ ok: true, message: "Sent." }),
    loadImage: async () => null,
    say: noop,
    storeImage: async () => ({ error: "no" }),
    contextId: "w1",
    loading: false,
    busy: false,
    listings: { "": ROOT_LISTING },
    expanded: new Set<string>(),
    toggleFolder: noop,
    collapseAll: noop,
    selectedPath: null,
    opening: null,
    select: () => true,
    deselect: () => true,
    search: async () => ({
      hits: [],
      indexMissing: false,
      indexIncomplete: false,
      reducedRecall: false,
      reducedRecallNotes: [],
    }),
  };
  return { ...base, ...over } as FileBrowser;
}

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(agents?: AgentActivityView, files: FileBrowser = browser()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(
        SafeAreaProvider,
        { initialMetrics: METRICS },
        createElement(Explorer, { files, contextLabel: "@somebody", agents }),
      ),
    );
  });
  return container;
}

const press = (element: Element) =>
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

const text = (container: HTMLElement) => container.textContent ?? "";


const agent = (n: number, kind: "read" | "write" = "read") => ({
  id: `a:${String(n).padStart(16, "0")}`,
  name: `Agent ${n}`,
  color: "#3b82f6",
  at: Date.now() - n * 1000,
  kind,
  path: "1-projects/alpha.md",
  reads: kind === "read" ? 1 : 0,
  writes: kind === "write" ? 1 : 0,
});

describe("the agents line at the foot of the tree", () => {
  test("no agents is no line", () => {
    const container = mount({ agents: [], marks: [] });
    expect(container.querySelector('[data-testid="explorer-agents"]')).toBeNull();
    expect(container.querySelector('[data-testid="explorer-counts"]')).not.toBeNull();
  });

  test("a hundred agents are still one line", () => {
    const agents = Array.from({ length: 100 }, (_, n) => agent(n));
    const container = mount({ agents, marks: [] });
    const lines = container.querySelectorAll('[data-testid="explorer-agents"]');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain("100 agents active");
    // Nothing per agent is drawn until the line is pressed.
    expect(container.querySelectorAll('[data-testid^="agent-row-"]')).toHaveLength(0);
  });

  test("pressing it lists who, and a row opens the note it names", () => {
    const opened: string[] = [];
    const container = mount(
      { agents: [agent(1, "write")], marks: [] },
      browser({ select: (path: string) => { opened.push(path); return true; } }),
    );
    press(container.querySelector('[data-testid="explorer-agents"]')!);
    expect(container.querySelector('[data-testid="explorer-agents-list"]')).not.toBeNull();
    expect(text(container)).toContain("Wrote alpha");
    press(container.querySelector('[data-testid^="agent-row-"]')!);
    expect(opened).toEqual(["1-projects/alpha.md"]);
    expect(container.querySelector('[data-testid="explorer-agents-list"]')).toBeNull();
  });
});

describe("the square in the tree", () => {
  test("a closed folder carries the mark for what is under it, in words", () => {
    const container = mount({
      agents: [agent(1, "write")],
      marks: [{ path: "1-projects/alpha.md", kind: "write", at: Date.now(), agent: "a:1" }],
    });
    expect(container.querySelectorAll('[data-testid="agent-mark-write"]')).toHaveLength(1);
    const labels = [...container.querySelectorAll("[aria-label]")].map((element) =>
      element.getAttribute("aria-label"),
    );
    expect(
      labels.some((label) => label?.startsWith("projects, folder") && label.endsWith("an agent wrote here recently")),
    ).toBe(true);
  });

  test("no marks, no squares", () => {
    const container = mount({ agents: [], marks: [] });
    expect(container.querySelector('[data-testid^="agent-mark-"]')).toBeNull();
  });
});
