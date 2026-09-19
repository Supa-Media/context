/**
 * @jest-environment jsdom
 */

/**
 * `‹ ›` AT THE HEAD OF THE NOTE'S PATH, ON A POINTER.
 *
 * The console has held a history of where somebody has been since the phone's
 * toolbar was built — `features/console/files/history.ts`, a browser-shaped
 * cursor into a list of places, with its own suite. It was drawn in exactly
 * one place: `ConsoleBottomBar`, which `frame.ts` renders at `compact` only.
 *
 * So on a desktop the state was complete, correct, tested, and unreachable.
 * "The note I was just looking at" — a destination somebody reaches constantly
 * and cannot see — was found by going back to the tree and looking for it. The
 * owner's words: "there should also be a back button of sorts for navigation".
 *
 * That is the failure this file exists for, and it is the repository's most
 * expensive recurring one: a route with no way in. A reducer test cannot catch
 * it, because the reducer was never wrong. This mounts the real pane at a
 * pointer width and asserts the controls are **on the screen** and wired to
 * the console's own history.
 *
 * `noteChrome.test.ts` is the compact half — one row of chrome above a note —
 * and is why the pair is absent there rather than drawn twice: the bottom bar
 * has carried them under the thumb all along.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
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
import { ConsoleNavProvider, type ConsoleNav } from "../features/console/ConsoleNavContext";
import type { ConsoleData } from "../features/console/types";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";
import { emptyEditor } from "../features/console/files/editor";

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
function consoleData(): ConsoleData {
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

function mount(nav: ConsoleNav | null, width = 1440): HTMLElement {
  widthOf(width);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const pane = createElement(BrowsePane, { data: consoleData() });
  act(() => {
    root.render(
      nav === null ? pane : createElement(ConsoleNavProvider, { value: nav, children: pane }),
    );
  });
  return container;
}

function navWith(over: Partial<ConsoleNav> = {}): ConsoleNav & { went: string[] } {
  const went: string[] = [];
  return {
    went,
    follow: () => {},
    back: () => went.push("back"),
    forward: () => went.push("forward"),
    canBack: true,
    canForward: true,
    ...over,
  };
}

const find = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLElement>(`[aria-label="${label}"]`);

describe("the pointer layout has a back button at all", () => {
  test("both are drawn at the head of the note's path", () => {
    const container = mount(navWith());
    expect(find(container, "Go back")).not.toBeNull();
    expect(find(container, "Go forward")).not.toBeNull();
  });

  test("an available step is not announced as disabled", () => {
    const container = mount(navWith());
    expect(find(container, "Go back")?.getAttribute("aria-disabled")).toBeNull();
  });

  test("pressing back walks the console's own history", () => {
    const nav = navWith();
    const container = mount(nav);
    const back = find(container, "Go back");
    act(() => {
      back?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(nav.went).toEqual(["back"]);
  });

  test("pressing forward does too", () => {
    const nav = navWith();
    const container = mount(nav);
    act(() => {
      find(container, "Go forward")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(nav.went).toEqual(["forward"]);
  });

  test("at the ends of the history they are dimmed IN PLACE, not removed", () => {
    /*
      `ConsoleBottomBar`'s rule, and it is right for the same reason here:
      these two spend most of a session with at least one of them unavailable,
      and a line whose first two positions come and go moves every segment
      beside them each time somebody navigates.
    */
    const nav = navWith({ canBack: false, canForward: false });
    const container = mount(nav);
    const back = find(container, "Go back");
    expect(back).not.toBeNull();
    act(() => {
      back?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(nav.went).toEqual([]);
    // And it says so, rather than being announced as a button that works.
    expect(back?.getAttribute("aria-disabled")).toBe("true");
    expect(find(container, "Go forward")?.getAttribute("aria-disabled")).toBe("true");
  });

  test("a pane with no console above it draws neither", () => {
    // The landing page's demo console has no layout, so no history and nowhere
    // to go. A control that is present and does nothing is worse than none.
    const container = mount(null);
    expect(find(container, "Go back")).toBeNull();
    expect(find(container, "Go forward")).toBeNull();
  });
});

describe("the phone is not given a second copy", () => {
  test("at compact width the breadcrumb draws neither, because the bottom bar has them", () => {
    /*
      The control on "at every density". `ConsoleBottomBar` leads with `‹ ›`
      under the thumb; drawing them in the path row as well is two of one
      control on a 390pt screen, which is what the second drawer toggle was
      deleted for being.
    */
    const container = mount(navWith(), 390);
    expect(find(container, "Go back")).toBeNull();
    expect(find(container, "Go forward")).toBeNull();
  });
});
