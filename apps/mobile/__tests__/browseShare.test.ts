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
 *
 * ## This file is the pointer layout's half
 *
 * On a phone the control is no longer in the pane at all. The row it sat in was
 * a breadcrumb, and a breadcrumb is the second band of chrome Obsidian spends
 * nothing on — so the name became an inline title inside the document and Share
 * moved into the top bar's trailing group, where the reference puts its ⋯.
 * `noteChrome.test.ts` is the same claim on that surface, and the two together
 * are what stop the capability going missing on one of them.
 *
 * Everything here therefore mounts at a **pointer width**. Left at jsdom's
 * default the window measures 0, which reads as `compact`, and every assertion
 * below would be about a layout that no longer draws this button.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

/*
  The notch and the home indicator, as a number.

  Every screen now clears them through `features/app/Screen.tsx`, which reads
  `useSafeAreaInsets` — and that hook throws outside a `SafeAreaProvider`
  rather than answering zero. Mocking the hook is the same trade
  `appFrameRender.test.ts` makes: the insets are the platform's business, and a
  provider here would be a second thing under test.
*/
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

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

/**
 * A pointer window.
 *
 * react-native-web measures `document.documentElement.clientWidth`, which jsdom
 * reports as 0 — see `appFrameRender.test.ts` for the full trap. Zero reads as
 * `compact`, which is the one density this file is *not* about.
 */
function pointerWidth(): void {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 1440,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));
}

function mount(element: ReturnType<typeof createElement>): HTMLElement {
  pointerWidth();
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
function dataWith(over: Partial<FileBrowser> = {}, entry: Partial<FolderListing["entries"][number]> = {}): ConsoleData {
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

  return data;
}

function paneWith(
  over: Partial<FileBrowser> = {},
  entry: Partial<FolderListing["entries"][number]> = {},
): HTMLElement {
  return mount(createElement(BrowsePane, { data: dataWith(over, entry) }));
}

/**
 * A pane that can be re-rendered, which is the only way to reach the case
 * below: `<Slot/>` in `app/(app)/console/_layout.tsx` reconciles by component
 * type with **no `key`**, so this component and its `sharing` state survive
 * `/console/@a` → `/console/@b`. A fresh mount per assertion cannot see that.
 */
function paneRoot(): {
  container: HTMLElement;
  render: (data: ConsoleData) => void;
} {
  pointerWidth();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return {
    container,
    render: (data: ConsoleData) =>
      act(() => {
        root.render(createElement(BrowsePane, { data }));
      }),
  };
}

function press(testID: string): void {
  const node = document.body.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  if (node === null) throw new Error(`no element with testID ${testID}`);
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

/** The dialog names the note it is about; that is what makes a stale one visible. */
const shareDialogFor = (name: string) =>
  document.body.querySelector(`[aria-label="Share ${name}"]`);

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

/**
 * **The button was the whole test, and everything past it was unpinned.**
 *
 * Nothing pressed it. Measured: pointing `onPress` at `"privacy.md"` — so that
 * the button on any note opens a dialog for the access map — left all 1,668
 * checks green, as did making the button inert, as did rendering the dialog
 * unconditionally for every open note. The file's own read-only test is *about*
 * `privacy.md`, which is what makes the first of those worth naming.
 */
describe("the dialog is about the note the reader is looking at", () => {
  test("pressing Share opens a dialog named after this note", () => {
    const pane = paneRoot();
    pane.render(dataWith());
    expect(shareDialogFor("plan.md")).toBeNull();
    press("browse-share");
    expect(shareDialogFor("plan.md")).not.toBeNull();
  });

  /**
   * **The one that matters.** `{sharing !== null ? <ShareDialog … />}` re-checks
   * nothing — not `canShare`, not the selection, not `readOnly` — and `<Slot/>`
   * reconciles this pane by component type with no `key`, so `sharing` survives
   * a context switch.
   *
   * Left open, submitting called the *new* context's `share` with the *old*
   * context's path. `createShare` checks `requireWorkspaceRole(owner)` and the
   * path's syntax, and never that the path exists in that workspace — so under
   * PARA conventions, where `1-projects/plan.md` plausibly exists in both, the
   * owner grants a recipient read access to a note they did not aim at.
   *
   * The guard closes the keyboard route too. `BrowsePane` reports no
   * `onOverlayChange`, so every GLOBAL binding fires behind this dialog and the
   * palette can change the selection under it; a dialog pinned to the current
   * selection cannot then act on a stale path.
   */
  test("it does not follow the reader into another context", () => {
    const pane = paneRoot();
    pane.render(dataWith());
    press("browse-share");
    // The positive control: without it, a dialog that never opened would
    // satisfy the assertion below.
    expect(shareDialogFor("plan.md")).not.toBeNull();

    const shareB = jest.fn();
    pane.render(
      dataWith(
        { selectedPath: "1-projects/other.md", share: shareB },
        { path: "1-projects/other.md", name: "other.md" },
      ),
    );

    expect(shareDialogFor("plan.md")).toBeNull();
    expect(shareB).not.toHaveBeenCalled();
  });

  test("nor does it outlive the capability that opened it", () => {
    const pane = paneRoot();
    pane.render(dataWith());
    press("browse-share");
    expect(shareDialogFor("plan.md")).not.toBeNull();

    // Ownership can go away under a mounted console — that is the whole subject
    // of `explorerMenuStaleGate.test.ts`. A dialog is a control like any other:
    // absent, not present-and-refused.
    pane.render(dataWith({ canShare: false }));
    expect(shareDialogFor("plan.md")).toBeNull();
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
