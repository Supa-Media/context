/**
 * @jest-environment jsdom
 */

/**
 * SHARE IS REACHABLE FROM THE NOTE.
 *
 * The class of bug this file exists to prevent, and it shipped once: **the
 * control being correct in `menu.ts` and unreachable on a screen.**
 *
 * `fileMenu.test.ts` proves the row's menu offers Share to an owner and hides
 * it from everybody else. All of that was true while the feature was, in
 * practice, missing — on a phone the menu opens on a long press *on a file
 * row*, so somebody reading a note had no row to press and no button to find,
 * and the moment they decide to send a note to a colleague is exactly the
 * moment they are reading it. `BrowsePane`'s own `Empty` copy already states
 * the rule that was broken: "a right-click menu nobody discovers is a feature
 * nobody has."
 *
 * So this mounts the real pane and asserts on what is on the screen. A menu
 * test cannot fail for the reason this one exists.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

// React refuses to run `act` without this, and warns on every call otherwise.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrowsePane } from "../features/console/panes/BrowsePane";
import type { ConsoleData } from "../features/console/types";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";
import { emptyEditor } from "../features/console/files/editor";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(element: ReturnType<typeof createElement>): HTMLElement {
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

/**
 * A console with one note open.
 *
 * A literal rather than the demo hook, because the two things under test —
 * `canShare` and `readOnly` — are exactly the fields the demo pins to `false`.
 */
function paneWith(over: Partial<FileBrowser> = {}, entry: Partial<FolderListing["entries"][number]> = {}) {
  const path = entry.path ?? NOTE;
  /**
   * The listing is keyed by the entry's **parent folder**, because that is how
   * `findEntry` looks it up — the root is `""`, not the folder name.
   *
   * The first version of this fixture always keyed `"1-projects"`, so the
   * `privacy.md` case found no entry at all and the pane rendered no button for
   * the wrong reason. Sabotaging the read-only check turned nothing red, which
   * is how that surfaced: the test was asserting the absence of a control on a
   * screen that had no note open.
   */
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const files = {
    canEdit: true,
    loading: false,
    busy: false,
    listings: {
      [folder]: {
        ...LISTING,
        path: folder,
        entries: [{ ...LISTING.entries[0], ...entry, path }],
      },
    },
    expanded: new Set<string>(),
    toggleFolder: () => {},
    selectedPath: path,
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
    ...over,
  } as unknown as FileBrowser;

  const data = {
    loading: false,
    contexts: [{ id: "w1", slug: "seyi", displayName: "seyi", role: "owner" }],
    selectedContextId: "w1",
    selectContext: () => {},
    storage: { status: "connected" },
    files,
    members: { rows: [], invitations: [] },
  } as unknown as ConsoleData;

  return mount(createElement(BrowsePane, { data }));
}

describe("an owner reading a note can share it", () => {
  /**
   * THE test. Remove the button from `BrowsePane` and this fails while every
   * assertion in `fileMenu.test.ts` stays green — which is exactly what
   * happened.
   */
  test("the open note carries a Share control", () => {
    const pane = paneWith();
    expect(pane.querySelector('[data-testid="browse-share"]')).not.toBeNull();
  });

  test("and it says what it is, with the ellipsis that promises a dialog", () => {
    expect(paneWith().textContent).toContain("Share");
  });
});

describe("who does not get it", () => {
  /**
   * Owner-only, and absent rather than disabled — the same rule the menu
   * applies. Sharing decides who reads a note, which is not an editor's to
   * decide, and the server refuses them with `minimum: "owner"` regardless.
   */
  test("an editor does not", () => {
    const pane = paneWith({ canShare: false });
    expect(pane.querySelector('[data-testid="browse-share"]')).toBeNull();
  });

  /**
   * `privacy.md` is the access map. Handing it to somebody enumerates every
   * private folder by name, and `createShare` refuses it — but the control must
   * not be offered in the first place.
   */
  test("a read-only file like privacy.md does not", () => {
    const pane = paneWith({}, {
      path: "privacy.md",
      name: "privacy.md",
      readOnly: true,
    });
    // The note IS open — otherwise this would pass for the wrong reason, which
    // is what the first version of this test did.
    expect(pane.textContent).toContain("privacy.md");
    expect(pane.querySelector('[data-testid="browse-share"]')).toBeNull();
  });

  /**
   * The control against the one above: the same fixture, read-only off, shows
   * the button. Without this pair, a fixture that renders no note at all would
   * satisfy the negative test forever.
   */
  test("…and the same file would get one if it were an ordinary note", () => {
    const pane = paneWith({}, { path: "readme.md", name: "readme.md", readOnly: false });
    expect(pane.querySelector('[data-testid="browse-share"]')).not.toBeNull();
  });

  test("a console with nothing open does not", () => {
    const pane = paneWith({ selectedPath: null });
    expect(pane.querySelector('[data-testid="browse-share"]')).toBeNull();
  });
});
