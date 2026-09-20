/**
 * @jest-environment jsdom
 */

/**
 * The folder listing's right-click, which is the one that was missing.
 *
 * `rowInteractions.web.ts` has bound `contextmenu` on tree rows for a long
 * time, so the tree behaved. `FolderView` bound nothing at all — no
 * `Pressable`, no listener, no menu — and it is the largest surface in the
 * console and the *only* browse surface on a phone. So a right-click on a
 * folder full of somebody's notes reached the document and opened the
 * browser's menu over them: Save As, Cast, Translate to English.
 *
 * These assertions are deliberately literal about the DOM for the reason
 * `treeInteractions.test.ts` gives: the rules live in `menu.ts` and
 * `actions.ts` and have their own tests, and what cannot be seen from either is
 * whether the gesture ever arrives. That is the whole of the bug.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

const { FolderView } =
  require("../features/console/files/FolderView") as typeof import("../features/console/files/FolderView");
type FileEntry = import("../features/console/files/types").FileEntry;
type FolderListing = import("../features/console/files/types").FolderListing;

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

function entry(over: Partial<FileEntry> & Pick<FileEntry, "path" | "name">): FileEntry {
  return {
    kind: "file",
    visibility: "team",
    inherited: "team",
    exception: false,
    readOnly: false,
    ...over,
  } as FileEntry;
}

const FOLDER = entry({ path: "2-areas", name: "2-areas", kind: "folder" });

const LISTING: FolderListing = {
  folderDefault: "team",
  entries: [
    entry({ path: "2-areas/health", name: "health", kind: "folder" }),
    entry({ path: "2-areas/journal.md", name: "journal.md" }),
  ],
} as FolderListing;

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(menu?: {
  onRow: (e: FileEntry, a: { x: number; y: number }) => boolean;
  onBackground: (a: { x: number; y: number }) => boolean;
}) {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 1440,
    configurable: true,
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  act(() => {
    root.render(
      createElement(FolderView, {
        entry: FOLDER,
        listing: LISTING,
        canSetVisibility: true,
        contextLabel: "@seyi",
        onSelect: () => {},
        menu,
      } as never),
    );
  });

  /** The element a row's gesture is attached to: the wrapper around the row. */
  const rowFor = (drawn: string): HTMLElement => {
    const label = Array.from(container.querySelectorAll("*")).find(
      (node) => node.textContent === drawn && node.children.length === 0,
    );
    if (label === undefined) throw new Error(`no row labelled ${drawn}`);
    return label.parentElement!.parentElement!;
  };

  /** The listing's own outer element, which carries the background gesture. */
  const background = (): HTMLElement => container.firstElementChild as HTMLElement;

  return { container, rowFor, background };
}

const rightClick = (over: MouseEventInit = {}) =>
  new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...over });

function noMenu() {
  return {
    onRow: () => false,
    onBackground: () => false,
  };
}

/* -------------------------------------------------------------------------- */

describe("a row in the listing", () => {
  test("a real contextmenu event reaches the menu, with the entry it is about", () => {
    const seen: string[] = [];
    const view = mount({ onRow: (e) => (seen.push(e.path), true), onBackground: () => false });

    act(() => {
      view.rowFor("journal").dispatchEvent(rightClick());
    });

    expect(seen).toEqual(["2-areas/journal.md"]);
  });

  test("a folder row too, not only a note", () => {
    const seen: string[] = [];
    const view = mount({ onRow: (e) => (seen.push(e.path), true), onBackground: () => false });

    act(() => {
      view.rowFor("health").dispatchEvent(rightClick());
    });

    expect(seen).toEqual(["2-areas/health"]);
  });

  test("it carries the pointer position, so the popover can be anchored", () => {
    let anchor: { x: number; y: number } | null = null;
    const view = mount({
      onRow: (_e, a) => ((anchor = a), true),
      onBackground: () => false,
    });

    act(() => {
      view.rowFor("journal").dispatchEvent(rightClick({ clientX: 88, clientY: 42 }));
    });

    expect(anchor).toEqual({ x: 88, y: 42 });
  });

  test("the browser's own menu is suppressed, or ours opens behind it", () => {
    const view = mount({ onRow: () => true, onBackground: () => false });
    const event = rightClick();

    act(() => {
      view.rowFor("journal").dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });

  /**
   * The rule that makes the background safe to put on the whole view: a row
   * that answered must not let the gesture through to the folder behind it, or
   * one right-click opens a menu about a note and then replaces it with a menu
   * about its folder.
   */
  test("a row that answers keeps the folder behind it out of it", () => {
    const background: unknown[] = [];
    const view = mount({ onRow: () => true, onBackground: () => (background.push(1), true) });

    act(() => {
      view.rowFor("journal").dispatchEvent(rightClick());
    });

    expect(background).toEqual([]);
  });
});

describe("the folder behind the rows", () => {
  /**
   * The heading, the visibility line and the space beside a short name are all
   * this folder, and right-clicking any of them is a right-click on it in every
   * file manager there is.
   */
  test("right-clicking the listing itself opens the folder's own menu", () => {
    let opened = 0;
    const view = mount({ onRow: () => true, onBackground: () => (opened += 1, true) });

    act(() => {
      view.background().dispatchEvent(rightClick());
    });

    expect(opened).toBe(1);
  });

  test("and suppresses the browser's menu once it has something to show", () => {
    const view = mount({ onRow: () => true, onBackground: () => true });
    const event = rightClick();

    act(() => {
      view.background().dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });
});

describe("never suppress a menu you are not going to answer", () => {
  /**
   * A read-only console has nothing to offer on empty space — `menu.ts` returns
   * an empty list — and the right answer there is the browser's own menu, not a
   * bordered rectangle with nothing in it and not a gesture that does nothing.
   */
  test("a handler that declines leaves the platform menu alone", () => {
    const view = mount(noMenu());
    const onRow = rightClick();
    const onBackground = rightClick();

    act(() => {
      view.rowFor("journal").dispatchEvent(onRow);
      view.background().dispatchEvent(onBackground);
    });

    expect(onRow.defaultPrevented).toBe(false);
    expect(onBackground.defaultPrevented).toBe(false);
  });

  test("a listing with no menu at all is left entirely alone", () => {
    const view = mount(undefined);
    const event = rightClick();

    act(() => {
      view.rowFor("journal").dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
  });

  /** Shift is the way back to Inspect, here as on a tree row. */
  test("shift hands the gesture back to the browser", () => {
    const seen: string[] = [];
    const view = mount({ onRow: (e) => (seen.push(e.path), true), onBackground: () => true });
    const event = rightClick({ shiftKey: true });

    act(() => {
      view.rowFor("journal").dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(seen).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                            a breadcrumb segment                            */
/* -------------------------------------------------------------------------- */

const { Breadcrumb } =
  require("../features/console/files/Breadcrumb") as typeof import("../features/console/files/Breadcrumb");

function mountCrumb(
  onFolderMenu?: (folder: string, a: { x: number; y: number }) => boolean,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  act(() => {
    root.render(
      createElement(Breadcrumb, {
        path: "2-areas/health/sleep.md",
        visibility: "team",
        inherited: "team",
        exception: false,
        readOnly: false,
        onSelectFolder: () => {},
        onFolderMenu,
      } as never),
    );
  });

  const segment = (path: string): HTMLElement => {
    const node = container.querySelector<HTMLElement>(
      `[data-testid="breadcrumb-folder-${path}"]`,
    );
    if (node === null) throw new Error(`no crumb for ${path}`);
    return node;
  };
  /** Nullable on purpose: this density draws no leaf, which is what is asserted. */
  const leaf = (): HTMLElement | null =>
    container.querySelector<HTMLElement>('[data-testid="breadcrumb-leaf"]');

  return { container, segment, leaf };
}

describe("the breadcrumb's folder segments", () => {
  /**
   * The fastest route to a parent folder's verbs, and it offered none: the
   * crumb naming the folder you are standing in was inert to the second mouse
   * button, and the tree was the only place that folder could be created in,
   * addressed, or have its visibility set.
   */
  test("right-clicking one opens the menu for that folder", () => {
    const seen: string[] = [];
    const bar = mountCrumb((folder) => (seen.push(folder), true));

    act(() => {
      bar.segment("2-areas").dispatchEvent(rightClick());
    });

    expect(seen).toEqual(["2-areas"]);
  });

  test("each segment names its own folder, not the leaf's", () => {
    const seen: string[] = [];
    const bar = mountCrumb((folder) => (seen.push(folder), true));

    act(() => {
      bar.segment("2-areas/health").dispatchEvent(rightClick());
    });

    expect(seen).toEqual(["2-areas/health"]);
  });

  /**
   * The leaf is not a control in this bar, and now it is not in this bar.
   *
   * It used to be drawn and inert: pressing it would re-select what is already
   * open, and a menu on it would have made it a control halfway. The pointer
   * breadcrumb draws folders only now — the note's name is the H1 below the
   * line and the tab above it — so the question the old assertion answered
   * cannot arise here at all.
   *
   * Asserted as absence rather than deleted, because absence is the stronger
   * claim and the one a reversal would break: put the leaf back and it is a
   * segment with no menu handler again, which is where the original hazard
   * lived. The phone still draws one (`pathOnly`), and `crumbs.ts` still
   * builds it — `Breadcrumb` filters it out at this density rather than
   * `crumbsFor` dropping it, so nothing about the phone's line changed.
   */
  test("the leaf is not on this line at all", () => {
    const seen: string[] = [];
    const bar = mountCrumb((folder) => (seen.push(folder), true));

    expect(bar.leaf()).toBeNull();
    // And the folders it sits between are still here, so this is not passing
    // because nothing rendered.
    expect(bar.segment("2-areas")).not.toBeNull();
    expect(bar.segment("2-areas/health")).not.toBeNull();
    expect(seen).toEqual([]);
  });

  test("a bar with no menu leaves the browser's alone", () => {
    const bar = mountCrumb(undefined);
    const event = rightClick();

    act(() => {
      bar.segment("2-areas").dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                               from the keyboard                            */
/* -------------------------------------------------------------------------- */

const menuKey = (over: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", {
    key: "ContextMenu",
    bubbles: true,
    cancelable: true,
    ...over,
  });

describe("the keyboard reaches the listing's menu too", () => {
  /**
   * Otherwise every verb this menu holds is mouse-only — and several have no
   * chord at all. Worse here than in the tree: the folder listing is the only
   * browse surface on a phone, so a keyboard-only person would have no route to
   * a note's visibility at all.
   */
  function withBox(node: HTMLElement) {
    node.getBoundingClientRect = () =>
      ({ left: 24, top: 120, bottom: 156, right: 300, width: 276, height: 36, x: 24, y: 120 }) as DOMRect;
  }

  test("Shift+F10 on a row opens its menu", () => {
    const seen: string[] = [];
    const view = mount({ onRow: (e) => (seen.push(e.path), true), onBackground: () => false });
    const row = view.rowFor("journal");
    withBox(row);

    act(() => {
      row.dispatchEvent(menuKey({ key: "F10", shiftKey: true }));
    });

    expect(seen).toEqual(["2-areas/journal.md"]);
  });

  test("and it anchors under the row rather than at the pointer", () => {
    let anchor: { x: number; y: number } | null = null;
    const view = mount({ onRow: (_e, a) => ((anchor = a), true), onBackground: () => false });
    const row = view.rowFor("journal");
    withBox(row);

    act(() => {
      row.dispatchEvent(menuKey());
    });

    expect(anchor).toEqual({ x: 24, y: 156 });
  });

  test("a bare F10 belongs to the browser", () => {
    const seen: string[] = [];
    const view = mount({ onRow: (e) => (seen.push(e.path), true), onBackground: () => false });
    const row = view.rowFor("journal");
    withBox(row);
    const event = menuKey({ key: "F10" });

    act(() => {
      row.dispatchEvent(event);
    });

    expect(seen).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  test("a handler that declines does not swallow the key", () => {
    const view = mount(noMenu());
    const row = view.rowFor("journal");
    withBox(row);
    const event = menuKey();

    act(() => {
      row.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
  });
});
