/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * The action menu, mounted for real — both presentations.
 *
 * `fileMenu.test.ts` pins the *items* — which of them exist, in what order,
 * with what words — as a pure model with no renderer. This file checks the
 * other half: that the components actually draw that model.
 *
 * Most of it is the **touch sheet** (`Menu.tsx`), which is what a bare
 * `../features/design/components/Menu` resolves to under Jest — there is no
 * platform-extension resolution here, so the touch file is the one that runs.
 * The pointer popover is required by name at the bottom, for the one property
 * that cannot be checked any other way: that it flips at the edges of the
 * window instead of hanging off them.
 *
 * Three things a menu can do wrong under a thumb, none of which are being
 * done:
 *
 *  - **A destructive row must not look like every other row.** "Delete
 *    forever…" is one row above "Cancel" and one mis-tap away from being
 *    pressed; it carries the critical colour or the sheet is lying about what
 *    it is offering.
 *  - **A submenu parent must not dispatch.** `menu.ts` gives the Visibility
 *    item the id `"visibility"`, which no dispatcher handles, precisely so that
 *    a slip is a no-op rather than a privacy change — but the row still has to
 *    *open the submenu* rather than fire at all. A component that called
 *    `onSelect("visibility")` on the way to opening the page would look
 *    perfectly fine on screen.
 *  - **A row must be a thumb target.** 44pt is the floor; a 28px pointer row
 *    reads fine on a laptop and mis-taps on a phone.
 *
 * ## What this can and cannot assert
 *
 * jsdom lays nothing out, so this is a **render test, not a layout test**. It
 * can resolve react-native-web's injected stylesheet — so "this row declares a
 * 44px minimum" and "the sheet's bottom padding clears the home indicator" are
 * real assertions — but it cannot tell you the sheet is 80% of the screen or
 * that the grab handle is centred. Those were checked in a browser at 390×844.
 *
 * Two jsdom facts this file depends on, both of which fail silently rather than
 * loudly if you get them wrong:
 *
 *  - react-native-web's `Dimensions` measures
 *    `document.documentElement.clientWidth`, and **jsdom reports that as 0**.
 *    Anything with a width branch in it lands in the phone branch for the wrong
 *    reason unless the element is stubbed and a `resize` dispatched. This sheet
 *    has no width branch, but the stub keeps every measurement RNW makes from
 *    being taken against a zero-width window.
 *  - RNW expands the `overflow` shorthand into `overflow-x`/`overflow-y`, so
 *    `getComputedStyle(node).overflow` comes back `""`. Assert the longhands.
 */

// `mock`-prefixed so `jest.mock`'s hoisted factory may close over it.
const mockInsets = { top: 0, bottom: 34, left: 0, right: 0 };

// The sheet sits on the bottom edge, so it reads the home indicator. The insets
// themselves are the platform's business, not this component's.
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

// Imported after the mock, which `jest.mock` hoists above it anyway.
// The `.tsx` extension is explicit, and has to be: `jest.config.js` resolves
// `.web.tsx` ahead of `.tsx` so the suite exercises the code that actually
// ships to a browser. A bare `.../Menu` here would hand these sheet tests the
// popover and quietly assert nothing about the sheet. The web half is required
// separately, by its own name, further down.
const { Menu } = require("../features/design/components/Menu.tsx") as typeof import("../features/design/components/Menu");
const { itemsFor } = require("../features/console/files/menu") as typeof import("../features/console/files/menu");
const { colors } = require("../features/design/tokens") as typeof import("../features/design/tokens");

type MenuActionId = import("../features/console/files/menu").MenuActionId;
type MenuItem = import("../features/console/files/menu").MenuItem;
type TreeRow = import("../features/console/files/tree").TreeRow;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

function note(path: string): TreeRow {
  return {
    kind: "file",
    key: path,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    depth: 0,
    expanded: false,
    selected: false,
    markerIsDefault: false,
    readOnly: false,
  };
}

/** The real menu for a note on a phone — not a hand-written list of items. */
function sheetItems(): MenuItem[] {
  return itemsFor({
    target: { kind: "row", row: note("1-projects/plan.md") },
    canEdit: true,
    clipboard: null,
    platform: "touch",
  });
}

interface Mounted {
  selected: MenuActionId[];
  dismissals: number;
  find: (testID: string) => HTMLElement | null;
  labels: () => string[];
  press: (testID: string) => void;
}

/**
 * Mounted sheets, torn down after every test.
 *
 * `Modal` portals into `document.body`, and every query in here goes through
 * `document.body` because of it — so a sheet left behind by a test that threw
 * is a sheet the *next* test finds first. Unmounting at the end of each test
 * body does not cover that case, which is precisely the case where the output
 * matters: a single broken assertion would otherwise be reported as five, four
 * of them in components that are fine. (Found by sabotage-testing this file:
 * breaking one row style failed four unrelated tests.)
 */
const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

function mountSheet(items: MenuItem[] = sheetItems()): Mounted {
  // See the module comment: jsdom performs no layout, so RNW's window is 0×0
  // unless the document element is stubbed and the cache invalidated.
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 390,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 844,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const selected: MenuActionId[] = [];
  const state = { dismissals: 0 };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  act(() => {
    root.render(
      createElement(Menu, {
        items,
        title: "plan.md",
        onSelect: (id: MenuActionId) => selected.push(id),
        onDismiss: () => {
          state.dismissals += 1;
        },
      }),
    );
  });

  // `Modal` renders through a portal into `document.body`, so nothing the sheet
  // draws is inside `container`.
  const find = (testID: string) =>
    document.body.querySelector<HTMLElement>(`[data-testid="${testID}"]`);

  return {
    selected,
    get dismissals() {
      return state.dismissals;
    },
    find,
    labels: () =>
      Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid^="menu-label-"]')).map(
        (node) => node.textContent ?? "",
      ),
    press: (testID: string) => {
      const node = find(testID);
      if (node === null) throw new Error(`no element with testID ${testID}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
  };
}

const styleOf = (node: HTMLElement, property: string): string =>
  window.getComputedStyle(node).getPropertyValue(property);

/* -------------------------------------------------------------------------- */

describe("the sheet draws the menu it was given", () => {
  test("every item is a row, in the order the model put them in", () => {
    const sheet = mountSheet();
    const items = sheetItems();

    expect(sheet.labels()).toEqual([...items.map((item) => item.label), "Cancel"]);
    for (const item of items) expect(sheet.find(`menu-item-${item.id}`)).not.toBeNull();

    // The file name, so a sheet that slid up over a list says which row it is
    // about.
    expect(sheet.find("menu-title")?.textContent).toBe("plan.md");
  });

  /**
   * `menu.ts` omits `shortcut` entirely on touch. This is the other end of that:
   * nothing here puts a chord back on a device with no keyboard.
   */
  test("no chords are printed on a sheet", () => {
    // Mounted for its effect on the document — `Modal` portals into
    // `document.body`, which is where the assertion below reads from.
    mountSheet();
    const text = document.body.textContent ?? "";
    for (const glyph of ["⌘", "⇧", "⌫", "Ctrl+"]) expect(text).not.toContain(glyph);
  });

  test("a destructive row is coloured differently from an ordinary one", () => {
    const sheet = mountSheet();
    const danger = sheet.find("menu-label-delete");
    const ordinary = sheet.find("menu-label-open");
    expect(danger).not.toBeNull();
    expect(ordinary).not.toBeNull();

    const dangerColor = styleOf(danger!, "color");
    expect(dangerColor).not.toBe(styleOf(ordinary!, "color"));
    // …and it is the palette's critical colour, not merely "some other colour".
    expect(dangerColor.replace(/\s/g, "")).toBe(
      `rgb(${[1, 3, 5].map((at) => parseInt(colors.critText.slice(at, at + 2), 16)).join(",")})`,
    );
  });

  /** A thumb lands within about 10mm of where it is aimed. */
  test("a row is at least 44pt tall", () => {
    const sheet = mountSheet();
    expect(styleOf(sheet.find("menu-item-delete")!, "min-height")).toBe("44px");
    expect(styleOf(sheet.find("menu-item-cancel")!, "min-height")).toBe("44px");
  });

  /**
   * The home indicator sits over the bottom ~34pt of an iPhone's screen, and
   * the sheet is anchored to that edge — so the last row is the one that ends
   * up underneath it.
   */
  test("the bottom inset is left clear", () => {
    const sheet = mountSheet();
    const padding = Number.parseFloat(styleOf(sheet.find("menu-sheet")!, "padding-bottom"));
    expect(padding).toBeGreaterThanOrEqual(mockInsets.bottom);
  });

  /** A menu longer than the sheet scrolls rather than growing off the screen. */
  test("the list scrolls", () => {
    const sheet = mountSheet();
    // RNW expands the `overflow` shorthand, so the shorthand reads as "".
    expect(styleOf(sheet.find("menu-list")!, "overflow-y")).toMatch(/auto|scroll/);
  });
});

describe("choosing something", () => {
  test("a row selects its own id and closes the sheet", () => {
    const sheet = mountSheet();
    sheet.press("menu-item-archive");
    expect(sheet.selected).toEqual(["archive"]);
    expect(sheet.dismissals).toBe(1);
  });

  test("Cancel closes and chooses nothing", () => {
    const sheet = mountSheet();
    sheet.press("menu-item-cancel");
    expect(sheet.selected).toEqual([]);
    expect(sheet.dismissals).toBe(1);
  });

  test("the scrim closes and chooses nothing", () => {
    const sheet = mountSheet();
    const scrim = document.body.querySelector<HTMLElement>('[aria-label="Close menu"]');
    expect(scrim).not.toBeNull();
    act(() => {
      scrim!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      scrim!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      scrim!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(sheet.selected).toEqual([]);
    expect(sheet.dismissals).toBeGreaterThanOrEqual(1);
  });
});

describe("a submenu is a second page, not a nested popover", () => {
  test("opening Visibility dispatches nothing and closes nothing", () => {
    const sheet = mountSheet();
    sheet.press("menu-item-visibility");

    // The failure this guards: a row that opens the page *and* fires. The id
    // has no handler, so on screen it would look correct.
    expect(sheet.selected).toEqual([]);
    expect(sheet.dismissals).toBe(0);
  });

  test("the page replaces the first one, with a way back", () => {
    const sheet = mountSheet();
    sheet.press("menu-item-visibility");

    expect(sheet.labels()).toEqual([
      "‹  Visibility",
      "Private",
      "Team",
      "Follow folder",
      "Cancel",
    ]);
    // The first page is gone rather than layered underneath.
    expect(sheet.find("menu-item-delete")).toBeNull();

    sheet.press("menu-item-back");
    expect(sheet.find("menu-item-delete")).not.toBeNull();
    expect(sheet.selected).toEqual([]);
  });

  test("a child row selects the real id and closes", () => {
    const sheet = mountSheet();
    sheet.press("menu-item-visibility");
    sheet.press("menu-item-visibilityTeam");
    expect(sheet.selected).toEqual(["visibilityTeam"]);
    expect(sheet.dismissals).toBe(1);
  });
});

describe("asking to close", () => {
  /**
   * Escape and the Android back button are the same request as far as this
   * component is concerned: `Modal`'s `onRequestClose`. react-native-web raises
   * it from Escape, and it only arms that listener once the modal is *active* —
   * which, for an animated modal, is after the slide-in animation ends. jsdom
   * runs no animations, so the test has to say the animation finished.
   */
  test("Escape dismisses", () => {
    const sheet = mountSheet();

    // `Modal` portals into a fresh `div` under `document.body`; the element
    // carrying `onAnimationEnd` is that portal's only child.
    let portal: HTMLElement | null = sheet.find("menu-sheet");
    while (portal !== null && portal.parentElement !== document.body) {
      portal = portal.parentElement;
    }
    const animation = portal?.firstElementChild ?? null;
    expect(animation).not.toBeNull();

    act(() => {
      animation!.dispatchEvent(new Event("animationend", { bubbles: true }));
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
    });

    expect(sheet.dismissals).toBeGreaterThanOrEqual(1);
    expect(sheet.selected).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                             the pointer popover                            */
/* -------------------------------------------------------------------------- */

/**
 * Required by path, because Jest has no platform-extension resolution: a bare
 * `./Menu` gives the touch sheet. This is the same `Menu` the web bundle gets.
 */
const web = require("../features/design/components/Menu.web") as typeof import("../features/design/components/Menu.web");
const { layout } = require("../features/design/tokens") as typeof import("../features/design/tokens");

/**
 * The two windows the web build has to answer, named against the token rather
 * than typed as numbers.
 *
 * `layout.narrowBreakpoint` is the same threshold `frame.ts` calls `compact`
 * and therefore the same one that makes `Explorer` ask `menu.ts` for the touch
 * item list — so a literal here would be a second breakpoint that agreed with
 * the first only until somebody moved one of them.
 */
const DESKTOP = { width: 1200, height: 800 };
const PHONE = { width: layout.narrowBreakpoint - 1, height: 844 };

interface Popover {
  selected: MenuActionId[];
  dismissals: number;
  panel: (which: "menu-root" | "menu-sub") => HTMLElement | null;
  box: (which: "menu-root" | "menu-sub") => { left: number; top: number; width: number; height: number };
  press: (testID: string) => void;
  key: (key: string) => void;
}

function mountPopover(
  anchor: { x: number; y: number },
  view: { width: number; height: number } = DESKTOP,
): Popover {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: view.width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: view.height,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const items = itemsFor({
    target: { kind: "row", row: note("1-projects/plan.md") },
    canEdit: true,
    clipboard: null,
    platform: "web",
  });

  const selected: MenuActionId[] = [];
  const state = { dismissals: 0 };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  act(() => {
    root.render(
      createElement(web.Menu, {
        items,
        anchor,
        onSelect: (id: MenuActionId) => selected.push(id),
        onDismiss: () => {
          state.dismissals += 1;
        },
      }),
    );
  });

  const panel = (which: "menu-root" | "menu-sub") =>
    document.body.querySelector<HTMLElement>(`[data-testid="${which}"]`);

  return {
    selected,
    get dismissals() {
      return state.dismissals;
    },
    panel,
    box: (which) => {
      const node = panel(which);
      if (node === null) throw new Error(`no panel ${which}`);
      const read = (property: string) =>
        Number.parseFloat(styleOf(node, property).replace("px", ""));
      return {
        left: read("left"),
        top: read("top"),
        width: read("width"),
        height: read("max-height"),
      };
    },
    press: (testID: string) => {
      const node = document.body.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
      if (node === null) throw new Error(`no element with testID ${testID}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    key: (key: string) => {
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    },
  };
}

describe("the popover flips rather than clipping", () => {
  /**
   * The whole reason this component computes its own geometry. A popover is
   * `position: fixed`, so a corner that falls outside the window is not
   * somewhere the page can be scrolled to — it is simply gone, and on a file
   * menu the row that goes missing is the last one: "Delete forever…".
   */
  test("with room, it opens down and to the right of the pointer", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    const box = menu.box("menu-root");
    expect(box.left).toBe(300);
    expect(box.top).toBe(200);
    expect(box.width).toBeGreaterThanOrEqual(200);
  });

  test("against the right edge it opens to the left, still on screen", () => {
    const menu = mountPopover({ x: 1150, y: 200 });
    const box = menu.box("menu-root");
    expect(box.left).toBeLessThan(1150);
    expect(box.left + box.width).toBeLessThanOrEqual(1200);
    expect(box.left).toBeGreaterThanOrEqual(0);
  });

  test("against the bottom edge it opens upward, still on screen", () => {
    const menu = mountPopover({ x: 300, y: 780 });
    const box = menu.box("menu-root");
    expect(box.top).toBeLessThan(780);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.top + box.height).toBeLessThanOrEqual(800);
  });

  test("in the bottom-right corner it flips both ways at once", () => {
    const menu = mountPopover({ x: 1180, y: 790 });
    const box = menu.box("menu-root");
    expect(box.left + box.width).toBeLessThanOrEqual(1200);
    expect(box.top + box.height).toBeLessThanOrEqual(800);
  });

  /** A window shorter than the menu has no side that fits; it scrolls. */
  test("a menu taller than the window is bounded by it", () => {
    const menu = mountPopover({ x: 100, y: 100 }, { width: 1200, height: 300 });
    const box = menu.box("menu-root");
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.top + box.height).toBeLessThanOrEqual(300);
    expect(styleOf(menu.panel("menu-root")!, "overflow-y")).not.toBe("visible");
  });

  /**
   * The same rule again, independently: a submenu is a box near an edge too,
   * and it is the box most likely to be near one — it starts where the parent
   * *ends*. One popover per test, because every query in here goes through
   * `document.body` and two mounted menus both answer to `menu-root`.
   */
  test("a submenu opens beside its parent", () => {
    const menu = mountPopover({ x: 200, y: 120 });
    menu.press("menu-item-visibility");
    const parentBox = menu.box("menu-root");
    const subBox = menu.box("menu-sub");
    expect(subBox.left).toBeGreaterThanOrEqual(parentBox.left + parentBox.width - 1);
    expect(subBox.left + subBox.width).toBeLessThanOrEqual(1200);
  });

  test("a submenu with no room to the right opens to the left of its parent", () => {
    const menu = mountPopover({ x: 1150, y: 120 });
    menu.press("menu-item-visibility");
    const parentBox = menu.box("menu-root");
    const subBox = menu.box("menu-sub");
    // Flipped across the parent entirely, rather than landing on top of it.
    expect(subBox.left + subBox.width).toBeLessThanOrEqual(parentBox.left + 1);
    expect(subBox.left).toBeGreaterThanOrEqual(0);
  });
});

describe("the popover's pointer and keyboard", () => {
  test("chords are printed on the web, unlike the sheet", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    expect(menu.panel("menu-root")?.textContent).toContain("⌘D");
  });

  test("a row selects its id and closes", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    menu.press("menu-item-archive");
    expect(menu.selected).toEqual(["archive"]);
    expect(menu.dismissals).toBe(1);
  });

  test("clicking the submenu parent opens it and dispatches nothing", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    menu.press("menu-item-visibility");
    expect(menu.selected).toEqual([]);
    expect(menu.dismissals).toBe(0);
    expect(menu.panel("menu-sub")).not.toBeNull();
  });

  test("down then Enter runs the first item", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    menu.key("ArrowDown");
    menu.key("Enter");
    expect(menu.selected).toEqual(["open"]);
    expect(menu.dismissals).toBe(1);
  });

  /** → enters a submenu, ← leaves it, and neither dispatches the parent. */
  test("the arrow keys walk into a submenu and back out", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    const items = itemsFor({
      target: { kind: "row", row: note("1-projects/plan.md") },
      canEdit: true,
      clipboard: null,
      platform: "web",
    });
    const at = items.findIndex((item) => item.id === "visibility");
    for (let step = 0; step <= at; step += 1) menu.key("ArrowDown");

    menu.key("ArrowRight");
    expect(menu.panel("menu-sub")).not.toBeNull();
    expect(menu.selected).toEqual([]);

    menu.key("ArrowLeft");
    expect(menu.panel("menu-sub")).toBeNull();
    expect(menu.selected).toEqual([]);

    // …and Enter inside it runs the child, not the parent.
    menu.key("ArrowRight");
    menu.key("Enter");
    expect(menu.selected).toEqual(["visibilityPrivate"]);
  });

  test("Escape dismisses and chooses nothing", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    menu.key("Escape");
    expect(menu.dismissals).toBe(1);
    expect(menu.selected).toEqual([]);
  });

  test("a click outside dismisses", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(menu.dismissals).toBe(1);
  });

  /**
   * A popover is anchored to a point in a document that can move under it.
   * Re-anchoring against a scroll would leave the menu pointing at whichever
   * row happens to be there now, which is how a menu acts on the wrong file.
   */
  test("scrolling anything dismisses", () => {
    const menu = mountPopover({ x: 300, y: 200 });
    act(() => {
      document.body.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(menu.dismissals).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                     the web build serves both devices                      */
/* -------------------------------------------------------------------------- */

/**
 * The bug this section exists for.
 *
 * `Menu.tsx`'s sheet is reachable only from a native build, and this product
 * reaches phones as a **web** build. So for the whole of this branch a long
 * press on a phone browser — which does raise `contextmenu`, correctly — opened
 * the 28px pointer popover: the exact mis-tap beside "Delete forever…" that the
 * sheet was written to prevent. `Explorer` was already passing
 * `platform: "touch"` at that width, so the *items* were right and only the
 * chrome was wrong, which is the kind of half-correct that survives review.
 *
 * The rule is `Palette`'s, deliberately: native is always the sheet (module
 * resolution decides that), and the browser asks the window.
 */
function mountWeb(
  view: { width: number; height: number },
  platform: "web" | "touch",
): {
  find: (testID: string) => HTMLElement | null;
  labels: () => string[];
  text: () => string;
} {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: view.width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: view.height,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const items = itemsFor({
    target: { kind: "row", row: note("1-projects/plan.md") },
    canEdit: true,
    clipboard: null,
    platform,
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  act(() => {
    root.render(
      createElement(web.Menu, {
        items,
        anchor: { x: 40, y: 60 },
        title: "plan.md",
        onSelect: () => {},
        onDismiss: () => {},
      }),
    );
  });

  return {
    // `Modal` portals into `document.body`, so the sheet is not inside
    // `container` and neither query may be scoped to it.
    find: (testID: string) =>
      document.body.querySelector<HTMLElement>(`[data-testid="${testID}"]`),
    labels: () =>
      Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid^="menu-label-"]')).map(
        (node) => node.textContent ?? "",
      ),
    text: () => document.body.textContent ?? "",
  };
}

describe("the web build picks its presentation on the window, not the bundle", () => {
  test("a phone-width viewport gets the sheet, not the popover", () => {
    const menu = mountWeb(PHONE, "touch");

    expect(menu.find("menu-sheet")).not.toBeNull();
    expect(menu.find("menu-root")).toBeNull();
    // The visible way out, on a sheet whose last row is destructive.
    expect(menu.find("menu-item-cancel")).not.toBeNull();
    expect(menu.find("menu-title")?.textContent).toBe("plan.md");
  });

  test("its rows are thumb targets — 44pt, from the web bundle", () => {
    const menu = mountWeb(PHONE, "touch");

    // The row that must not be mis-tapped, and the one directly under it.
    expect(styleOf(menu.find("menu-item-delete")!, "min-height")).toBe("44px");
    expect(styleOf(menu.find("menu-item-cancel")!, "min-height")).toBe("44px");
    // And nothing is pinned to the pointer height that caused this.
    expect(styleOf(menu.find("menu-item-delete")!, "height")).not.toBe("28px");
  });

  test("a desktop-width viewport gets the compact popover, with its chords", () => {
    const menu = mountWeb(DESKTOP, "web");

    expect(menu.find("menu-root")).not.toBeNull();
    expect(menu.find("menu-sheet")).toBeNull();
    expect(styleOf(menu.find("menu-item-delete")!, "height")).toBe("28px");
    expect(menu.text()).toContain("⌘D");
  });

  test("the switch is the layout token, not a number typed into the component", () => {
    const narrow = mountWeb({ width: layout.narrowBreakpoint - 1, height: 844 }, "touch");
    expect(narrow.find("menu-sheet")).not.toBeNull();
    while (mounted.length > 0) mounted.pop()?.();

    const wide = mountWeb({ width: layout.narrowBreakpoint, height: 844 }, "web");
    expect(wide.find("menu-root")).not.toBeNull();
  });

  /**
   * `menu.ts` omits `shortcut` at compact density, so normally there is nothing
   * to draw. This is the other end of that promise: handed the *pointer* list
   * at a phone width — which is what a mismatch between the two breakpoints
   * would produce — the sheet still prints no chord, because a column of chords
   * nobody can type costs a fifth of the width of a phone.
   */
  test("the sheet prints no chords even when handed some", () => {
    const menu = mountWeb(PHONE, "web");

    expect(menu.find("menu-sheet")).not.toBeNull();
    for (const glyph of ["⌘", "⇧", "⌫", "Ctrl+"]) expect(menu.text()).not.toContain(glyph);
  });

  /**
   * A submenu on a phone is a second page, not a popover hanging off the side
   * of another popover: there is nowhere to hang one and no hover to open it.
   */
  test("a submenu on the sheet pushes a page rather than a second panel", () => {
    const menu = mountWeb(PHONE, "touch");

    const parent = menu.find("menu-item-visibility");
    expect(parent).not.toBeNull();
    act(() => {
      parent!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      parent!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      parent!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(menu.find("menu-sub")).toBeNull();
    expect(menu.find("menu-item-back")).not.toBeNull();
    expect(menu.labels()).toEqual([
      "‹  Visibility",
      "Private",
      "Team",
      "Follow folder",
      "Cancel",
    ]);
  });

  /** The same danger promise the native sheet makes, from the web bundle. */
  test("a destructive row on the web sheet keeps the critical colour", () => {
    const menu = mountWeb(PHONE, "touch");
    const danger = menu.find("menu-label-delete");
    const ordinary = menu.find("menu-label-open");

    expect(styleOf(danger!, "color")).not.toBe(styleOf(ordinary!, "color"));
    expect(styleOf(danger!, "color").replace(/\s/g, "")).toBe(
      `rgb(${[1, 3, 5].map((at) => parseInt(colors.critText.slice(at, at + 2), 16)).join(",")})`,
    );
  });
});
