/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

/*
  Every screen clears the notch through `features/app/Screen.tsx`, which reads
  `useSafeAreaInsets` — and that hook throws outside a `SafeAreaProvider`
  rather than answering zero.
*/
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrowsePane } from "../features/console/panes/BrowsePane";
import { emptyEditor } from "../features/console/files/editor";
import { entryAt } from "../features/console/files/tree";
import type { ConsoleData } from "../features/console/types";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";

/**
 * A folder route lists its own contents, whatever the tree has been doing.
 *
 * ## The bug
 *
 * The console fetches one folder at a time, and `findEntry` answers from a
 * path's **parent** listing. So "which thing is selected" was answerable only
 * for a path whose parent somebody had already expanded — and `BrowsePane` read
 * an unanswerable one as *nothing selected* and drew "Choose a note to read or
 * edit it".
 *
 * Which means `/console/@seyi?note=3-resources/books` showed one of two
 * completely different screens for the same URL, decided by what the person had
 * happened to tap in the sidebar earlier in the session. A link somebody was
 * sent, a restored tab, or a reload with the tree collapsed got the empty
 * state — over a folder whose own listing had, by then, already arrived.
 *
 * ## What is asserted
 *
 * The two entry paths that were broken, with `expanded` empty and the parent's
 * listing absent — which is precisely the cold-start state — and the third that
 * always worked, so the fix is not a fix in one direction only.
 */

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function phoneWidth(): void {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 390,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 844,
    configurable: true,
  });
  // Inside `act`, because react-native-web's `Dimensions` answers a resize with
  // a `setState` on every mounted component that reads it.
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

function mount(element: ReturnType<typeof createElement>): HTMLElement {
  phoneWidth();
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

const FOLDER = "3-resources/books";

/** What `listFiles` returns for the folder itself, and nothing else. */
const OWN_LISTING: FolderListing = {
  path: FOLDER,
  folderDefault: "team",
  entries: [
    {
      kind: "folder",
      path: `${FOLDER}/reviews`,
      name: "reviews",
      visibility: "team",
      inherited: "team",
      exception: false,
      readOnly: false,
    },
    {
      kind: "file",
      path: `${FOLDER}/deep-work.md`,
      name: "deep-work.md",
      visibility: "team",
      inherited: "team",
      exception: false,
      readOnly: false,
    },
  ],
  truncated: false,
  manifestUsable: true,
};

function consoleWith(files: Partial<FileBrowser>): ConsoleData {
  return {
    loading: false,
    contexts: [{ id: "w1", slug: "seyi", displayName: "seyi", role: "owner" }],
    selectedContextId: "w1",
    selectContext: () => {},
    storage: { status: "connected" },
    failure: null,
    members: { rows: [], invitations: [] },
    files: {
      canEdit: true,
      loading: false,
      busy: false,
      // **Nothing but the folder's own listing.** No root, no parent — the
      // state a cold load with the sidebar closed is actually in.
      listings: { [FOLDER]: OWN_LISTING },
      expanded: new Set<string>(),
      toggleFolder: () => {},
      selectedPath: FOLDER,
      select: () => {},
      editor: emptyEditor,
      setDraft: () => {},
      save: () => {},
      useTheirs: () => {},
      keepMine: () => {},
      discard: () => {},
      notice: null,
      dismissNotice: () => {},
      clipboard: null,
      toasts: [],
      dismissToast: () => {},
      canResetPrivacy: false,
      resetPrivacy: () => {},
      canSetVisibility: true,
      canShare: false,
      shares: [],
      share: () => {},
      revokeShare: () => {},
      setSharePreviewTitle: () => {},
      teamShareLink: () => {},
      ...files,
    } as unknown as FileBrowser,
  } as unknown as ConsoleData;
}

describe("a folder opened without its parent", () => {
  test("lists its children with the tree's expansion state empty", () => {
    const container = mount(createElement(BrowsePane, { data: consoleWith({}) }));
    expect(container.textContent).toContain("reviews");
    expect(container.textContent).toContain("deep-work");
    // The empty state is the failure this exists to catch, so name it.
    expect(container.textContent).not.toContain("Choose a note to read");
  });

  test("is the same screen as reaching it through the tree", () => {
    /*
      The same folder, with its *parent* loaded as well — which is what
      expanding the tree produces. The two mounts must agree, because they are
      one URL.
    */
    const throughTree = consoleWith({
      listings: {
        [FOLDER]: OWN_LISTING,
        "3-resources": {
          path: "3-resources",
          folderDefault: "team",
          entries: [
            {
              kind: "folder",
              path: FOLDER,
              name: "books",
              visibility: "team",
              inherited: "team",
              exception: false,
              readOnly: false,
            },
          ],
          truncated: false,
          manifestUsable: true,
        },
      },
    } as Partial<FileBrowser>);

    const cold = mount(createElement(BrowsePane, { data: consoleWith({}) })).textContent;
    const warm = mount(createElement(BrowsePane, { data: throughTree })).textContent;
    expect(cold).toBe(warm);
  });
});

describe("the same coupling on the note route", () => {
  /**
   * A note reached by a link has no parent listing either, and until now that
   * showed the empty state over an editor that had the note open. The
   * visibility fields ride on `EditorState` for exactly this — there is nowhere
   * else the console holds them for a note whose folder it has never listed.
   */
  const NOTE = "3-resources/books/deep-work.md";
  const opened: OpenNote = {
    path: NOTE,
    text: "# Deep work\n\nnotes",
    etag: "e1",
    visibility: "team",
    inherited: "private",
    exception: true,
    readOnly: false,
  };

  test("a deep-linked note renders the note, not the empty state", () => {
    const container = mount(
      createElement(BrowsePane, {
        data: consoleWith({
          listings: {},
          selectedPath: NOTE,
          editor: {
            ...emptyEditor,
            status: "clean",
            path: NOTE,
            baseline: opened.text,
            draft: opened.text,
            etag: opened.etag,
            visibility: opened.visibility,
            inherited: opened.inherited,
            exception: opened.exception,
          },
        } as Partial<FileBrowser>),
      }),
    );
    expect(container.textContent).not.toContain("Choose a note to read");
    expect(container.textContent).toContain("Deep work");
  });
});

describe("entryAt", () => {
  test("prefers the parent listing, which is the only place that knows the exception", () => {
    const parent: FolderListing = {
      path: "3-resources",
      folderDefault: "private",
      entries: [
        {
          kind: "folder",
          path: FOLDER,
          name: "books",
          visibility: "team",
          inherited: "private",
          exception: true,
          readOnly: false,
        },
      ],
      truncated: false,
      manifestUsable: true,
    };
    const entry = entryAt({ "3-resources": parent, [FOLDER]: OWN_LISTING }, FOLDER);
    expect(entry?.exception).toBe(true);
  });

  test("falls back to the folder's own listing, and understates rather than invents", () => {
    const entry = entryAt({ [FOLDER]: OWN_LISTING }, FOLDER);
    expect(entry).toEqual({
      kind: "folder",
      path: FOLDER,
      name: "books",
      visibility: "team",
      inherited: "team",
      exception: false,
      readOnly: false,
    });
  });

  test("knows nothing about a path nothing has loaded", () => {
    expect(entryAt({}, "3-resources/nowhere")).toBeNull();
  });
});
