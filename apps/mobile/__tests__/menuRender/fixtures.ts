/**
 * @jest-environment jsdom
 */

import { afterEach, jest } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { displayName } from "../../features/console/files/paths";

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
 *
 * This module carries the shared mounting harness for every file in this
 * folder; it has no tests of its own.
 */

// `mock`-prefixed so `jest.mock`'s hoisted factory may close over it.
export const mockInsets = { top: 0, bottom: 34, left: 0, right: 0 };

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
const { Menu } = require("../../features/design/components/Menu.tsx") as typeof import("../../features/design/components/Menu");
export { Menu };
export const { itemsFor } = require("../../features/console/files/menu") as typeof import("../../features/console/files/menu");
export const { darkColors } = require("../../features/design/tokens") as typeof import("../../features/design/tokens");
export const { ThemeProvider } = require("../../features/design/theme") as typeof import("../../features/design/theme");

/**
 * Required by path, because Jest has no platform-extension resolution: a bare
 * `./Menu` gives the touch sheet. This is the same `Menu` the web bundle gets.
 */
export const web = require("../../features/design/components/Menu.web") as typeof import("../../features/design/components/Menu.web");
export const { layout } = require("../../features/design/tokens") as typeof import("../../features/design/tokens");

export type MenuActionId = import("../../features/console/files/menu").MenuActionId;
export type MenuItem = import("../../features/console/files/menu").MenuItem;
export type TreeRow = import("../../features/console/files/tree").TreeRow;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

export function note(path: string): TreeRow {
  return {
    kind: "file",
    key: path,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    label: displayName(path.slice(path.lastIndexOf("/") + 1)),
    depth: 0,
    expanded: false,
    selected: false,
    markerIsDefault: false,
    readOnly: false,
  };
}

/** The real menu for a note on a phone — not a hand-written list of items. */
export function sheetItems(): MenuItem[] {
  return itemsFor({
    target: { kind: "row", row: note("1-projects/plan.md") },
    canEdit: true,
    canSetVisibility: true,
    canShare: true,
    canDownload: true,
    clipboard: null,
    platform: "touch",
  });
}

export interface Mounted {
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
export const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

export function mountSheet(items: MenuItem[] = sheetItems()): Mounted {
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
      createElement(ThemeProvider, {
        scheme: "dark",
        children: createElement(Menu<MenuActionId>, {
          items,
          title: "plan.md",
          onSelect: (id: MenuActionId) => selected.push(id),
          onDismiss: () => {
            state.dismissals += 1;
          },
        }),
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

export const styleOf = (node: HTMLElement, property: string): string =>
  window.getComputedStyle(node).getPropertyValue(property);

/** The real folder menu, whose visibility submenu is the one carrying details. */
export function folderRow(path: string): TreeRow {
  return { ...note(path), kind: "folder", path, name: path };
}

export function folderItems(platform: "web" | "touch"): MenuItem[] {
  return itemsFor({
    target: { kind: "row", row: folderRow("1-projects") },
    canEdit: true,
    canSetVisibility: true,
    canShare: true,
    canDownload: true,
    clipboard: null,
    platform,
  });
}

/**
 * The two windows the web build has to answer, named against the token rather
 * than typed as numbers.
 *
 * `layout.narrowBreakpoint` is the same threshold `frame.ts` calls `compact`
 * and therefore the same one that makes `Explorer` ask `menu.ts` for the touch
 * item list — so a literal here would be a second breakpoint that agreed with
 * the first only until somebody moved one of them.
 */
export const DESKTOP = { width: 1200, height: 800 };
export const PHONE = { width: layout.narrowBreakpoint - 1, height: 844 };

export interface Popover {
  selected: MenuActionId[];
  dismissals: number;
  panel: (which: "menu-root" | "menu-sub") => HTMLElement | null;
  box: (which: "menu-root" | "menu-sub") => { left: number; top: number; width: number; height: number };
  press: (testID: string) => void;
  key: (key: string) => void;
}

export function mountPopover(
  anchor: { x: number; y: number },
  view: { width: number; height: number } = DESKTOP,
  /** Override the items, for the rules that need a shape `itemsFor` never makes. */
  custom?: MenuItem[],
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

  const items =
    custom ??
    itemsFor({
      target: { kind: "row", row: note("1-projects/plan.md") },
      canEdit: true,
      canSetVisibility: true,
      canShare: true,
      canDownload: true,
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
      createElement(ThemeProvider, {
        scheme: "dark",
        children: createElement(web.Menu<MenuActionId>, {
          items,
          anchor,
          onSelect: (id: MenuActionId) => selected.push(id),
          onDismiss: () => {
            state.dismissals += 1;
          },
        }),
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
export function mountWeb(
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
    canSetVisibility: true,
    canShare: true,
    canDownload: true,
    clipboard: null,
    platform,
  });

  return mountWebWith(items, view);
}

/**
 * The same mount, given the items outright.
 *
 * `mountWeb` builds the note menu; a submenu page is a list this file has to
 * hand over itself, because the popover renders a child page from the items it
 * was given rather than by opening the parent.
 */
export function mountWebWith(
  items: MenuItem[],
  view: { width: number; height: number },
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

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  act(() => {
    root.render(
      createElement(ThemeProvider, {
        scheme: "dark",
        children: createElement(web.Menu, {
          items,
          anchor: { x: 40, y: 60 },
          title: "plan.md",
          onSelect: () => {},
          onDismiss: () => {},
        }),
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
