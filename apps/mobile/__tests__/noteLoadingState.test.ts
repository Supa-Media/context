/**
 * @jest-environment jsdom
 */

/**
 * A NOTE ON ITS WAY NEVER LOOKS LIKE AN EMPTY NOTE.
 *
 * Owner, 2026-10-11: opening a note "displayed the 'write in markdown' empty
 * file text and then later populates with the actual text after 2-3 seconds …
 * users [might] think for a split second their file has no content." The pane
 * mounted the editor for the selected note before the read had landed, so the
 * editor showed its placeholder over a note that was nothing of the kind.
 *
 * This mounts the real pane with an open in flight and nothing on screen
 * before it (the case `useShownEntry` cannot hold a page for) and asserts the
 * loading state is drawn and the editor is not.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useQueries: () => ({}),

  // An owner picker searches through the client; nothing here opens one.
  useConvex: () => ({ query: async () => undefined }),
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrowsePane } from "../features/console/panes/BrowsePane";
import type { ConsoleData } from "../features/console/types";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";
import { emptyEditor } from "../features/console/files/editor";
import { NOTE_LOADING_DELAY_MS } from "../features/console/panes/browsePane/NoteLoading";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const NOTE = "1-projects/plan.md";

const LISTING: FolderListing = {
  path: "1-projects",
  folderDefault: "team",
  entries: [
    {
      kind: "file",
      path: NOTE,
      name: "plan.md",
      visibility: "team",
      inherited: "team",
      exception: false,
      readOnly: false,
    },
  ],
  truncated: false,
  manifestUsable: true,
};

/** A console with one note open, the way `browseShare.test.ts` builds one. */
function consoleData(over: Partial<FileBrowser> = {}): ConsoleData {
  const files = {
    canEdit: true,
    contextId: "w1",
    loading: false,
    busy: false,
    listings: { "1-projects": LISTING },
    expanded: new Set<string>(),
    toggleFolder: () => {},
    selectedPath: NOTE,
    opening: null,
    select: () => {},
    navigations: 0,
    editor: emptyEditor,
    setDraft: () => {},
    save: () => {},
    useTheirs: () => {},
    keepMine: () => {},
    conflict: null,
    resolveWith: () => {},
    discard: () => {},
    notice: null,
    dismissNotice: () => {},
    clipboard: null,
    copy: () => {},
    cut: () => {},
    paste: () => {},
    copyTo: () => {},
    createNote: () => {},
    createFolder: () => {},
    rename: () => {},
    move: () => {},
    duplicate: () => {},
    archive: () => {},
    destroy: () => {},
    setVisibility: () => {},
    resetPrivacy: () => {},
    canResetPrivacy: false,
    canSetVisibility: true,
    canShare: true,
    shares: [],
    share: () => {},
    revokeShare: () => {},
    setSharePreviewTitle: () => {},
    contextMoves: [],
    ...over,
  } as unknown as FileBrowser;

  return {
    loading: false,
    contexts: [{ id: "w1", slug: "seyi", displayName: "seyi", role: "owner" }],
    selectedContextId: "w1",
    selectContext: () => {},
    storage: { status: "connected" },
    files,
    members: { rows: [], invitations: [] },
  } as unknown as ConsoleData;
}

/**
 * A window of the given width.
 *
 * react-native-web measures `document.documentElement.clientWidth`, which jsdom
 * reports as 0 — and zero reads as `compact`, which is the density half of
 * what this file is about.
 */
function widthOf(width: number): void {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));
}

function mount(over: Partial<FileBrowser>, width = 1440): HTMLElement {
  widthOf(width);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(BrowsePane, { data: consoleData(over) }));
  });
  return container;
}


const EDITOR = '[contenteditable="true"], [data-testid="note-editor"]';

describe("opening a note with nothing on screen before it", () => {
  test("draws the loading state, not an empty editor", () => {
    const container = mount({ opening: NOTE });
    expect(container.querySelector('[data-testid="note-loading"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Write in markdown");
    expect(container.querySelector(EDITOR)).toBeNull();
  });

  test("says it is loading to a screen reader", () => {
    const container = mount({ opening: NOTE });
    const region = container.querySelector('[data-testid="note-loading"]');
    expect(region?.getAttribute("aria-label")).toBe("Opening note");
    expect(region?.getAttribute("aria-busy")).toBe("true");
  });

  test("a quick read shows nothing at first, then the bars", () => {
    jest.useFakeTimers();
    try {
      const container = mount({ opening: NOTE });
      expect(container.querySelector('[data-testid="note-loading-lines"]')).toBeNull();
      act(() => {
        jest.advanceTimersByTime(NOTE_LOADING_DELAY_MS + 10);
      });
      expect(container.querySelector('[data-testid="note-loading-lines"]')).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a link straight to a note, before any listing names it, is loading too", () => {
    const container = mount({ opening: NOTE, listings: {} });
    expect(container.querySelector('[data-testid="note-loading"]')).not.toBeNull();
  });

  test("once the editor holds the note, the note is drawn", () => {
    const container = mount({
      opening: null,
      editor: { ...emptyEditor, path: NOTE, draft: "# Plan\n", baseline: "# Plan\n", etag: "e1" },
    });
    expect(container.querySelector('[data-testid="note-loading"]')).toBeNull();
  });

  test("a folder being opened is not drawn as a note loading", () => {
    const container = mount({ selectedPath: "1-projects", opening: "1-projects", listings: {} });
    expect(container.querySelector('[data-testid="note-loading"]')).toBeNull();
  });
});
