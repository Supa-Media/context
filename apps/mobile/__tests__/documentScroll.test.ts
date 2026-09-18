/**
 * @jest-environment jsdom
 */

/**
 * A folder page that is taller than the window can be scrolled.
 *
 * ## The bug
 *
 * `BrowsePane` has two layouts. On a phone the whole document region is one
 * scroller (`browse-scroll`) and everything drawn into it — a folder listing,
 * the Inbox, a channel, a contact — scrolls as a page. On a pointer layout
 * that branch is not taken, and the region was a plain `View`:
 *
 *     {notices}
 *     <View style={styles.body}>{openDocument}</View>
 *
 * A note was fine, because `NoteEditor` owns a scroller; so were the conflict
 * resolver and a channel day. **Everything else had none at all.** A `View` on
 * react-native-web clips its overflow, so `4-archive` — fifty-odd rows — drew
 * as many rows as the window was tall and silently cut the rest off. No
 * scrollbar, no keyboard scroll, no way to reach the last row but to make the
 * window taller. Reported against `4-archive` on a desktop window.
 *
 * ## What is asserted
 *
 * At pointer width: the surfaces that do not bring a scroller are put inside
 * one, and the surfaces that do bring their own are **not** — a scroller
 * nested in a scroller is the other half of this bug, and it is the half a
 * screenshot does not show.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrowsePane } from "../features/console/panes/BrowsePane";
import { emptyEditor } from "../features/console/files/editor";
import type { ConsoleData } from "../features/console/types";
import type { FileBrowser } from "../features/console/files/browser";
import type { FileEntry, FolderListing } from "../features/console/files/types";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

/** A desktop window: wide enough that `densityFor` is not `compact`. */
function desktopWidth(): void {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 1440,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

function mount(element: ReturnType<typeof createElement>): HTMLElement {
  desktopWidth();
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

const FOLDER = "4-archive";

/** Fifty rows: the folder from the report, at the size that broke. */
const MANY: FileEntry[] = Array.from({ length: 50 }, (_, index) => ({
  kind: "file",
  path: `${FOLDER}/note-${index}.md`,
  name: `note-${index}.md`,
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
}));

const LISTING: FolderListing = {
  path: FOLDER,
  folderDefault: "team",
  entries: MANY,
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
    fastSearch: { status: null, loading: false },
    failure: null,
    members: { rows: [], invitations: [] },
    files: {
      canEdit: true,
      loading: false,
      busy: false,
      listings: { [FOLDER]: LISTING },
      expanded: new Set<string>(),
      toggleFolder: () => {},
      selectedPath: FOLDER,
      select: () => {},
      ensureListing: () => {},
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
      // No move into another context is running. `BrowsePane` reads this on
      // every render, so a fixture without it crashes the pane rather than
      // failing the assertion the test was written for.
      contextMoves: [],
    } as unknown as FileBrowser,
  } as unknown as ConsoleData;
}

function scroller(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="document-scroll"]');
}

describe("the document region on a pointer layout", () => {
  test("puts a folder listing in a scroller", () => {
    const container = mount(createElement(BrowsePane, { data: consoleWith({}) }));
    const scroll = scroller(container);
    expect(scroll).not.toBeNull();
    // The listing is *inside* it — a scroller beside the thing that overflows
    // would pass this check and fix nothing.
    expect(scroll!.querySelector('[data-testid="folder-column"]')).not.toBeNull();
    // And the last row is drawn, rather than the page ending where the window
    // does: a clipped listing renders every row too, so this only guards the
    // fixture.
    expect(container.textContent).toContain("note-49");
  });

  test("puts the Inbox in a scroller", () => {
    const container = mount(
      createElement(BrowsePane, {
        data: consoleWith({
          selectedPath: "0-inbox",
          listings: {
            "0-inbox": {
              path: "0-inbox",
              folderDefault: "private",
              entries: [
                {
                  kind: "folder",
                  path: "0-inbox/meetings",
                  name: "meetings",
                  visibility: "private",
                  inherited: "private",
                  exception: false,
                  readOnly: false,
                },
              ],
              truncated: false,
              manifestUsable: true,
            },
          },
        } as Partial<FileBrowser>),
      }),
    );
    expect(scroller(container)).not.toBeNull();
    expect(container.textContent).toContain("Inbox");
  });

  test("leaves a note alone, because the editor brings its own", () => {
    const NOTE = `${FOLDER}/note-0.md`;
    const container = mount(
      createElement(BrowsePane, {
        data: consoleWith({
          selectedPath: NOTE,
          editor: {
            ...emptyEditor,
            status: "clean",
            path: NOTE,
            baseline: "# note\n",
            draft: "# note\n",
            etag: "e1",
            visibility: "team",
            inherited: "team",
            exception: false,
          },
        } as Partial<FileBrowser>),
      }),
    );
    expect(scroller(container)).toBeNull();
  });
});
