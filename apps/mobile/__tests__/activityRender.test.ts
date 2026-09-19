/**
 * @jest-environment jsdom
 */

/**
 * THE INDICATOR, ON THE GLASS.
 *
 * `activity.test.ts` proves the rules. This proves the column is wired to them
 * — and the three claims that are only true of a rendered tree:
 *
 *  1. **The foot line is the counts line.** Nothing is added to the column
 *     when there is nothing to say. The whole feature was asked for as "a
 *     number of updates at the bottom… it doesn't have to be in your face",
 *     and a version that draws a second row at rest has already lost that.
 *  2. **Pressing it opens the list, and closing it catches up.** Not opening:
 *     a list that clears its own marker the instant it appears is one you
 *     cannot look away from and come back to.
 *  3. **A row opens the note it is about**, through the same `select` the tree
 *     uses, rather than a navigation of its own.
 *
 * ## Sabotage record
 *
 * Applied, both activity suites run, named test observed failing, reverted.
 *
 *  1. The foot line drawn whenever `activity` is present, rather than only
 *     when something is unseen.
 *     → **1 fails**: `a column with nothing new still ends at the counts line`.
 *  2. `markSeen` called on open as well as on close.
 *     → **2 fail**: `opening the list does not mark it read`, and the close
 *     case, which then counts two marks instead of one.
 *  3. The row's press dropped, so `select` is never reached.
 *     → **1 fails**: `a row opens the note it names`.
 *  4. `markedRows` marking only the note, never the folder above it.
 *     → **4 fail**, one of them here: `a collapsed folder carries the dot for
 *     what is under it`. The other three are the rule's own suite, which is
 *     the split this file is for — it proves the wiring, not the rule.
 *
 * The fixture builds its `unseenPaths` with the real `unseenNotePaths` rather
 * than re-deriving them, and that was not fussiness: the first version
 * computed them from every entry and passed a test that should have failed —
 * `and a context with nothing new has no dots at all` went green over a
 * component that was drawing one.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context";
import { Explorer } from "../features/console/files/Explorer";
import type { FileBrowser } from "../features/console/files/browser";
import {
  unseenCount,
  unseenNotePaths,
  type ActivityEntry,
  type ActivityView,
} from "../features/console/activity/activity";

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

function entry(over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    at: new Date(Date.now() - 4 * 60_000).toISOString(),
    kind: "added",
    paths: ["1-projects/alpha.md"],
    n: 1,
    vis: "team",
    by: "@sayo",
    via: "Claude",
    note: null,
    ...over,
  };
}

interface Seen {
  marked: number;
  opened: string[];
}

function view(entries: ActivityEntry[], seenAt: number | null, seen: Seen): ActivityView {
  return {
    entries,
    seenAt,
    unseen: unseenCount(entries, seenAt),
    // The real functions, not a re-derivation: a fixture that computes these
    // its own way is a fixture that can agree with a broken component.
    unseenPaths: unseenNotePaths(entries, seenAt),
    loaded: true,
    refresh: noop,
    markSeen: () => {
      seen.marked += 1;
    },
  };
}

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(activity?: ActivityView, files: FileBrowser = browser()) {
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
        createElement(Explorer, { files, contextLabel: "@somebody", activity }),
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

describe("the line at the foot of the tree", () => {
  test("a column with no activity at all is the column it always was", () => {
    const container = mount(undefined);
    expect(container.querySelector('[data-testid="explorer-counts"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="explorer-activity"]')).toBeNull();
  });

  test("a column with nothing new still ends at the counts line", () => {
    const seen: Seen = { marked: 0, opened: [] };
    const container = mount(view([entry()], Date.now(), seen));
    expect(container.querySelector('[data-testid="explorer-counts"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="explorer-activity"]')).toBeNull();
  });

  test("and says how much is new when there is something", () => {
    const seen: Seen = { marked: 0, opened: [] };
    const container = mount(view([entry()], Date.now() - 600_000, seen));
    const line = container.querySelector('[data-testid="explorer-activity"]');
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain("1 update");
  });
});

describe("the dot in the tree", () => {
  test("a collapsed folder carries the dot for what is under it", () => {
    const seen: Seen = { marked: 0, opened: [] };
    const container = mount(view([entry()], Date.now() - 600_000, seen));
    const labels = [...container.querySelectorAll("[aria-label]")].map((element) =>
      element.getAttribute("aria-label"),
    );
    // The folder is marked; nothing else is. The unseen note lives under it
    // and the tree has not been opened, so a dot on the note would be a dot
    // on a row nobody can see.
    expect(labels.filter((label) => label?.endsWith(", new"))).toHaveLength(1);
    // "projects", not "1-projects": the tree draws names without their sort
    // prefix, and the mark rides the row rather than the path.
    expect(
      labels.some((label) => label?.startsWith("projects, folder") && label.endsWith(", new")),
    ).toBe(true);
  });

  test("and a context with nothing new has no dots at all", () => {
    const seen: Seen = { marked: 0, opened: [] };
    const container = mount(view([entry()], Date.now(), seen));
    const labels = [...container.querySelectorAll("[aria-label]")].map((element) =>
      element.getAttribute("aria-label"),
    );
    expect(labels.some((label) => label?.endsWith(", new"))).toBe(false);
  });
});

describe("the list", () => {
  test("is not up until the line is pressed", () => {
    const seen: Seen = { marked: 0, opened: [] };
    const container = mount(view([entry()], Date.now() - 600_000, seen));
    expect(container.querySelector('[data-testid="explorer-activity-list"]')).toBeNull();
  });

  test("opening it re-reads the file, because state is older than the bucket", () => {
    const seen: Seen = { marked: 0, opened: [] };
    let refreshed = 0;
    const activity = { ...view([entry()], Date.now() - 600_000, seen), refresh: () => { refreshed += 1; } };
    const container = mount(activity);
    press(container.querySelector('[data-testid="explorer-activity"]')!);
    expect(refreshed).toBe(1);
  });

  test("opening the list does not mark it read", () => {
    const seen: Seen = { marked: 0, opened: [] };
    const container = mount(view([entry()], Date.now() - 600_000, seen));
    press(container.querySelector('[data-testid="explorer-activity"]')!);
    expect(container.querySelector('[data-testid="explorer-activity-list"]')).not.toBeNull();
    expect(seen.marked).toBe(0);
  });

  test("and closing it does", () => {
    const seen: Seen = { marked: 0, opened: [] };
    const container = mount(view([entry()], Date.now() - 600_000, seen));
    const line = container.querySelector('[data-testid="explorer-activity"]')!;
    press(line);
    press(line);
    expect(container.querySelector('[data-testid="explorer-activity-list"]')).toBeNull();
    expect(seen.marked).toBe(1);
  });

  test("says what happened, in a sentence rather than a log line", () => {
    const seen: Seen = { marked: 0, opened: [] };
    const container = mount(
      view([entry({ note: "screenshots of the editor bugs" })], Date.now() - 600_000, seen),
    );
    press(container.querySelector('[data-testid="explorer-activity"]')!);
    const list = container.querySelector('[data-testid="explorer-activity-list"]')!;
    expect(list.textContent).toContain("@sayo's Claude added 1-projects/alpha.md");
    expect(list.textContent).toContain("screenshots of the editor bugs");
  });

  test("a row opens the note it names", () => {
    const seen: Seen = { marked: 0, opened: [] };
    const files = browser({ select: (path: string) => (seen.opened.push(path), true) });
    const container = mount(view([entry()], Date.now() - 600_000, seen), files);
    press(container.querySelector('[data-testid="explorer-activity"]')!);
    const row = [...container.querySelectorAll('[role="button"]')].find((element) =>
      (element.textContent ?? "").includes("added 1-projects/alpha.md"),
    );
    expect(row).toBeDefined();
    press(row!);
    expect(seen.opened).toEqual(["1-projects/alpha.md"]);
    // And it closes behind you: the list is a glance, not a place.
    expect(container.querySelector('[data-testid="explorer-activity-list"]')).toBeNull();
  });

  test("offers the whole history as the note it is", () => {
    const seen: Seen = { marked: 0, opened: [] };
    const files = browser({ select: (path: string) => (seen.opened.push(path), true) });
    const container = mount(view([entry()], Date.now() - 600_000, seen), files);
    press(container.querySelector('[data-testid="explorer-activity"]')!);
    const more = [...container.querySelectorAll('[role="button"]')].find((element) =>
      (element.textContent ?? "").includes("Open the whole history"),
    );
    press(more!);
    expect(seen.opened).toEqual(["activity.md"]);
  });

  test("an empty list says what would fill it", () => {
    const seen: Seen = { marked: 0, opened: [] };
    // Unseen is forced, because the line only exists when something is new —
    // this is the shape where the read answered with nothing this reader may
    // see, which is a real state and must not draw an empty box.
    const empty: ActivityView = { ...view([], null, seen), unseen: 1 };
    const container = mount(empty);
    press(container.querySelector('[data-testid="explorer-activity"]')!);
    expect(text(container)).toContain("Nothing yet");
  });
});
