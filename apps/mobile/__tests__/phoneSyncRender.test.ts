/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Whether a phone can see that its notes are not synced — mounted.
 *
 * `phoneSync.test.ts` pins the rules as pure functions. This file asks the
 * question those cannot: whether the pill, the sheet and the row marks are
 * actually drawn once react-native-web has turned them into DOM, on the
 * surfaces a phone has — and, as much as anything, that nothing is drawn where
 * there is nothing to say.
 *
 * Every claim here was checked by sabotage: the case named beside each was
 * run against the change it describes and failed.
 */

const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

const { ThemeProvider } =
  require("../features/design/theme") as typeof import("../features/design/theme");
const { SyncPill, SyncSheet } =
  require("../features/console/files/SyncSheet") as typeof import("../features/console/files/SyncSheet");
const { FileTree } =
  require("../features/console/files/FileTree") as typeof import("../features/console/files/FileTree");
const { FolderView } =
  require("../features/console/files/FolderView") as typeof import("../features/console/files/FolderView");
const { RecentSheet } =
  require("../features/console/files/RecentSheet") as typeof import("../features/console/files/RecentSheet");
const { AppFrame } =
  require("../features/app/AppFrame") as typeof import("../features/app/AppFrame");
const { pendingMarks, NO_PENDING } =
  require("../features/console/files/pendingMarks") as typeof import("../features/console/files/pendingMarks");
const { saveChip } =
  require("../features/console/files/status") as typeof import("../features/console/files/status");
const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

type SyncFacts = import("../features/offline/copy").SyncFacts;
type TreeRow = import("../features/console/files/tree").TreeRow;
type FileEntry = import("../features/console/files/types").FileEntry;

/* -------------------------------------------------------------------------- */

const QUEUED = "1-projects/pilot.md";
const STUCK = "1-projects/budget.md";
const CLEAN = "1-projects/notes.md";

const MARKS = pendingMarks([
  { path: QUEUED, state: "pending", queuedAt: 1 },
  { path: STUCK, state: "conflicted", queuedAt: 2 },
]);

function sync(overrides: Partial<SyncFacts> = {}): SyncFacts {
  return {
    reachability: "online",
    counts: { pending: 0, conflicted: 0, rejected: 0 },
    durable: true,
    ready: true,
    ...overrides,
  };
}

const live: Array<() => void> = [];
afterEach(() => {
  while (live.length > 0) live.pop()?.();
  document.body.innerHTML = "";
});

function mount(element: ReactElement, width = 390) {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 800, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => root.render(createElement(ThemeProvider, { scheme: "dark", children: element })));
  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  // A `Modal` portals into `document.body`, so every query is document-wide.
  const find = (testID: string) =>
    document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  return {
    find,
    need: (testID: string) => {
      const node = find(testID);
      if (node === null) throw new Error(`nothing with testID ${testID}`);
      return node;
    },
    all: (testID: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testID}"]`)),
    click: (testID: string) => {
      const node = find(testID);
      if (node === null) throw new Error(`nothing with testID ${testID}`);
      act(() => node.click());
    },
    text: () => document.body.textContent ?? "",
  };
}

/* -------------------------------------------------------------------------- */

describe("the phone's header pill", () => {
  test("draws nothing online with nothing waiting", () => {
    // SABOTAGE: had `SyncPill` draw "Synced" for `null`. Fails here.
    const view = mount(createElement(SyncPill, { sync: sync(), save: null, onPress: () => {} }));
    expect(view.find("sync-pill")).toBeNull();
  });

  test("draws nothing while the platform has not said", () => {
    const view = mount(
      createElement(SyncPill, { sync: sync({ reachability: "unknown" }), save: null, onPress: () => {} }),
    );
    expect(view.find("sync-pill")).toBeNull();
  });

  test("says Offline and the count, and names every fact for a screen reader", () => {
    const view = mount(
      createElement(SyncPill, {
        sync: sync({ reachability: "offline", counts: { pending: 3, conflicted: 0, rejected: 0 } }),
        save: null,
        onPress: () => {},
      }),
    );
    const pill = view.need("sync-pill");
    expect(pill.textContent).toBe("Offline · 3");
    expect(pill.getAttribute("aria-label")).toBe(
      "Offline. 3 notes waiting to sync. Show sync details",
    );
    expect(pill.getAttribute("role")).toBe("button");
  });

  test("carries the open note's Cached copy", () => {
    const save = saveChip({
      editor: {
        ...emptyEditor,
        status: "clean",
        path: QUEUED,
        fromCache: true,
        message: "Showing the copy on this device, read 3 hours ago.",
      },
      now: 0,
    });
    const view = mount(createElement(SyncPill, { sync: sync(), save, onPress: () => {} }));
    expect(view.need("sync-pill").textContent).toBe("Cached copy");
  });

  test("a press opens the sheet", () => {
    let pressed = 0;
    const view = mount(
      createElement(SyncPill, {
        sync: sync({ reachability: "offline" }),
        save: null,
        onPress: () => {
          pressed += 1;
        },
      }),
    );
    view.click("sync-pill");
    expect(pressed).toBe(1);
  });
});

describe("the sheet behind it", () => {
  function sheet(onOpen: (path: string) => void = () => {}) {
    return mount(
      createElement(SyncSheet, {
        sync: sync({
          reachability: "offline",
          counts: { pending: 1, conflicted: 1, rejected: 0 },
          stuckPaths: [STUCK],
        }),
        save: null,
        pending: MARKS,
        onOpen,
        onDismiss: () => {},
      }),
    );
  }

  test("says all three states, in the strip's own words", () => {
    const view = sheet();
    expect(view.need("sync-section-connection").textContent).toContain("Offline");
    expect(view.need("sync-section-stuck").textContent).toContain("1 note needs you");
    expect(view.need("sync-section-waiting").textContent).toContain("1 note waiting to sync");
  });

  test("names each note under the block it belongs to, marked", () => {
    const view = sheet();
    const stuck = view.need("sync-section-stuck");
    const waiting = view.need("sync-section-waiting");
    expect(stuck.querySelector(`[data-testid="sync-note-${STUCK}"]`)).not.toBeNull();
    expect(stuck.querySelector('[data-testid="sync-mark-conflict"]')).not.toBeNull();
    expect(waiting.querySelector(`[data-testid="sync-note-${QUEUED}"]`)).not.toBeNull();
    expect(waiting.querySelector('[data-testid="sync-mark-queued"]')).not.toBeNull();
    expect(view.need(`sync-note-${STUCK}`).getAttribute("aria-label")).toBe("Open budget, needs you");
    expect(view.need(`sync-note-${QUEUED}`).getAttribute("aria-label")).toBe(
      "Open pilot, waiting to sync",
    );
  });

  test("a row opens its note, which is how a conflict is answered", () => {
    const opened: string[] = [];
    const view = sheet((path) => opened.push(path));
    view.click(`sync-note-${STUCK}`);
    expect(opened).toEqual([STUCK]);
  });

  test("closes itself when there is nothing left to say", () => {
    let dismissed = 0;
    mount(
      createElement(SyncSheet, {
        sync: sync(),
        save: null,
        pending: NO_PENDING,
        onOpen: () => {},
        onDismiss: () => {
          dismissed += 1;
        },
      }),
    );
    expect(dismissed).toBe(1);
  });
});

describe("the frame gives the pill a place on a phone and none elsewhere", () => {
  function frame(width: number) {
    return mount(
      createElement(AppFrame, {
        switcher: createElement("span", { "data-testid": "switcher" }, "@someone"),
        accountSlot: createElement("span", { "data-testid": "account" }, "you"),
        topTrailing: createElement("span", { "data-testid": "trailing" }, "actions"),
        syncSlot: createElement("span", { "data-testid": "sync-slot" }, "Offline"),
        status: createElement("span", { "data-testid": "status" }, "strip"),
        bottomBar: createElement("span", { "data-testid": "bottom" }, "toolbar"),
        children: "the note",
      }),
      width,
    );
  }

  test("at compact it is in the top row, between the account and the capsule", () => {
    const view = frame(390);
    const account = view.need("account");
    const slot = view.need("sync-slot");
    const trailing = view.need("trailing");
    expect(account.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.compareDocumentPosition(trailing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("at a pointer width it is refused — the strip says it there", () => {
    // SABOTAGE: dropped the `compact &&` on the slot. Fails here.
    const view = frame(1200);
    expect(view.find("sync-slot")).toBeNull();
    expect(view.find("status")).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

function treeRow(path: string): TreeRow {
  const name = path.split("/").pop()!;
  return {
    kind: "file",
    key: path,
    path,
    name,
    label: name.replace(/\.md$/, ""),
    depth: 1,
    expanded: false,
    selected: false,
    markerIsDefault: false,
    readOnly: false,
  };
}

function fileEntry(path: string): FileEntry {
  return {
    kind: "file",
    path,
    name: path.split("/").pop()!,
    visibility: "team",
    inherited: "team",
    exception: false,
    readOnly: false,
  };
}

/** The row element carrying `label`, by accessible name. */
function rowNamed(label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
}

describe("every list marks the notes that are not in the bucket", () => {
  test("the file tree", () => {
    // SABOTAGE: stopped passing `sync` to `FileRow`. Fails here.
    const view = mount(
      createElement(FileTree, {
        rows: [treeRow(QUEUED), treeRow(STUCK), treeRow(CLEAN)],
        canSetVisibility: false,
        onSelect: () => {},
        onToggle: () => {},
        onCycleVisibility: () => {},
        pendingStateFor: MARKS.stateFor,
      }),
      1200,
    );
    expect(view.all("sync-mark-queued")).toHaveLength(1);
    expect(view.all("sync-mark-conflict")).toHaveLength(1);
    expect(rowNamed("pilot, waiting to sync")).not.toBeNull();
    expect(rowNamed("budget, needs you")).not.toBeNull();
    // An unmarked note is named as it always was.
    expect(rowNamed("notes")).not.toBeNull();
  });

  test("the folder page, on a phone", () => {
    const view = mount(
      createElement(FolderView, {
        entry: { ...fileEntry("1-projects"), kind: "folder", name: "1-projects" },
        listing: {
          path: "1-projects",
          folderDefault: "team",
          entries: [fileEntry(QUEUED), fileEntry(STUCK), fileEntry(CLEAN)],
          truncated: false,
          manifestUsable: true,
        },
        canSetVisibility: true,
        contextLabel: "@someone",
        onSelect: () => {},
        pendingStateFor: MARKS.stateFor,
      }),
    );
    expect(view.all("sync-mark-queued")).toHaveLength(1);
    expect(view.all("sync-mark-conflict")).toHaveLength(1);
    const queued = view.need("sync-mark-queued");
    expect(queued.getAttribute("aria-label")).toBe("waiting to sync");
    expect(view.need("sync-mark-conflict").getAttribute("aria-label")).toBe("needs you");
    expect(rowNamed("pilot, waiting to sync")).not.toBeNull();
    expect(rowNamed("notes")).not.toBeNull();
  });

  test("the Recent sheet", () => {
    const view = mount(
      createElement(RecentSheet, {
        paths: [QUEUED, STUCK, CLEAN],
        currentPath: null,
        onOpen: () => {},
        onDismiss: () => {},
        pendingStateFor: MARKS.stateFor,
      }),
    );
    const queued = view.need(`recent-${QUEUED}`);
    const stuck = view.need(`recent-${STUCK}`);
    const clean = view.need(`recent-${CLEAN}`);
    expect(queued.querySelector('[data-testid="sync-mark-queued"]')).not.toBeNull();
    expect(stuck.querySelector('[data-testid="sync-mark-conflict"]')).not.toBeNull();
    expect(clean.querySelector('[data-testid^="sync-mark"]')).toBeNull();
    expect(queued.getAttribute("aria-label")).toBe("note pilot, projects, waiting to sync");
    expect(stuck.getAttribute("aria-label")).toBe("note budget, projects, needs you");
  });

  test("with no queue under them, nothing is marked", () => {
    const view = mount(
      createElement(FileTree, {
        rows: [treeRow(QUEUED)],
        canSetVisibility: false,
        onSelect: () => {},
        onToggle: () => {},
        onCycleVisibility: () => {},
      }),
      1200,
    );
    expect(view.find("sync-mark-queued")).toBeNull();
    expect(rowNamed("pilot")).not.toBeNull();
  });
});
