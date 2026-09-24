/**
 * @jest-environment jsdom
 */

import { afterEach, jest } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * The palette, mounted for real, on both of the shapes it ships as.
 *
 * `palette.test.ts` pins the *ranking* — a pure function over strings, with no
 * React in it. This file is the other half: that the component actually shows
 * that ranking, that the keyboard walks it, and that Enter opens the row the
 * highlight is on rather than the row that happens to be first.
 *
 * ## Why these assertions and not a snapshot
 *
 * Every one of these is a way the widget has a *silent* failure mode:
 *
 *  - **The highlight.** `Match.ranges` is the only reason the ranker returns
 *    anything but a score, and a palette that drops it still looks fine in a
 *    screenshot — it just stops explaining itself. Nothing else in the app
 *    would go red if the emphasis vanished.
 *  - **Enter versus the first row.** The obvious wrong implementation is
 *    `onChoose(matches[0].item)`, which is correct until somebody presses ↓.
 *    A test that only ever presses Enter cannot tell the two apart, so this
 *    one moves first and asserts the *second* item comes back.
 *  - **Which presentation rendered.** The two are chosen by a width
 *    comparison, and a comparison that is silently always false still produces
 *    a working palette — the wrong one, on a phone, with a floating panel
 *    under the software keyboard.
 *
 * ## Two things jsdom does that will waste your afternoon
 *
 *  1. **`document.documentElement.clientWidth` is 0.** jsdom performs no
 *     layout, and react-native-web's `Dimensions` measures exactly that
 *     property, caches it, and refreshes on `resize`. An unstubbed mount
 *     therefore reports a window 0px wide, lands in the phone branch, and
 *     every desktop assertion fails for a reason that has nothing to do with
 *     the component. `mount` below stubs it and dispatches the resize.
 *  2. **`react-native-web` renders through a portal.** `Modal` appends its own
 *     `div` to `document.body`, so the palette is *not* inside the container
 *     the test created. Everything here queries `document`.
 *
 * Sabotage runs recorded in the report: the highlight assertions and the
 * "Enter takes the selected row" assertion have both been checked against a
 * deliberately broken component.
 *
 * This module carries the shared mounting harness for every file in this
 * folder; it has no tests of its own.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The sheet reads the notch and the home indicator. A provider would be a
// second thing under test; the insets are the platform's business, not the
// palette's.
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Required after the mock, which `jest.mock` hoists above it anyway.
const { Palette } =
  require("../../features/design/components/Palette") as typeof import("../../features/design/components/Palette");
export { Palette };
export const { layout, darkColors } =
  require("../../features/design/tokens") as typeof import("../../features/design/tokens");
export const { ThemeProvider } =
  require("../../features/design/theme") as typeof import("../../features/design/theme");
export const { REDUCED_RECALL_DISPLAY_LIMIT } =
  require("../../features/console/files/useContextSearch") as typeof import("../../features/console/files/useContextSearch");
export type PaletteItem = import("../../features/console/files/palette").PaletteItem;

/* -------------------------------------------------------------------------- */

/**
 * Deliberately *not* in ranked order.
 *
 * "New note" is first, so "typing reorders the list" is a real claim: with an
 * empty query the command is row 0 (an untyped palette shows input order), and
 * after `note` it has to drop below the note whose name starts with it.
 */
export const ITEMS: PaletteItem[] = [
  { id: "cmd:new-note", label: "New note", detail: "⌘N", kind: "command" },
  { id: "0-inbox/today.md", label: "today.md", detail: "0-inbox", kind: "note" },
  {
    id: "3-resources/notes-on-storage.md",
    label: "notes-on-storage.md",
    detail: "3-resources",
    kind: "note",
  },
  {
    id: "1-projects/together-financial-management.md",
    label: "together-financial-management.md",
    detail: "1-projects",
    kind: "note",
  },
  {
    id: "1-projects/working-with-seyi.md",
    label: "working-with-seyi.md",
    detail: "1-projects",
    kind: "note",
  },
  { id: "2-areas", label: "2-areas", kind: "folder" },
];

export const PHONE = 390;
export const DESKTOP = 1280;

/**
 * Every mount, so a test that fails an assertion mid-way still tears its
 * palette down.
 *
 * This is not tidiness. `Modal` renders through a portal into
 * `document.body`, and every query in this file is a `document` query — so one
 * leaked palette makes the *next* test read the previous test's DOM, and it
 * reads it first. The failure that produces is a lie: assertions pass or fail
 * against a component that is not the one under test.
 */
const openPalettes: Array<() => void> = [];

afterEach(() => {
  while (openPalettes.length > 0) openPalettes.pop()!();
  document.body.innerHTML = "";
});

/** react-native-web resolves colours to `rgb()`; the tokens are hex. */
export function rgb(hex: string): string {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

export interface Mounted {
  type: (value: string) => void;
  press: (key: string) => void;
  click: (testID: string) => void;
  find: (testID: string) => HTMLElement | null;
  all: (selector: string) => HTMLElement[];
  rowLabels: () => string[];
  selectedRow: () => HTMLElement | null;
  chosen: PaletteItem[];
  dismissals: () => number;
  unmount: () => void;
}

export function mount(
  width: number,
  props: Partial<Parameters<typeof Palette>[0]> = {},
): Mounted {
  // See note 1 in the header: without this every mount is 0px wide.
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 800,
    configurable: true,
  });
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  act(() => {
    // Inside `act` because react-native-web's `Dimensions` answers this event
    // by setting state on every mounted component that reads the window.
    window.dispatchEvent(new Event("resize"));
  });

  const chosen: PaletteItem[] = [];
  let dismissed = 0;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  act(() => {
    root.render(
      createElement(ThemeProvider, {
        scheme: "dark",
        children: createElement(Palette, {
        items: ITEMS,
        placeholder: "Search this context",
        emptyHeading: "Recent",
        noMatchMessage: "Nothing here matches. Try fewer letters.",
        onChoose: (item) => chosen.push(item),
        onDismiss: () => {
          dismissed += 1;
        },
          ...props,
        }),
      }),
    );
  });

  const find = (testID: string) =>
    document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];

  let live = true;
  const unmount = () => {
    if (!live) return;
    live = false;
    act(() => root.unmount());
    container.remove();
  };
  openPalettes.push(unmount);

  return {
    chosen,
    dismissals: () => dismissed,
    find,
    all,
    type: (value: string) => {
      const input = find("palette-input") as HTMLInputElement | null;
      if (input === null) throw new Error("the palette has no filter input");
      // React tracks the last value it wrote to the node, so assigning
      // `input.value` directly makes it decide nothing changed. Going through
      // the prototype's setter is what makes React see the edit.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    press: (key: string) => {
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    },
    click: (testID: string) => {
      const node = find(testID);
      if (node === null) throw new Error(`no element with testID ${testID}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    rowLabels: () => all('[data-testid^="palette-row-"]').map((row) => row.textContent ?? ""),
    selectedRow: () => document.querySelector<HTMLElement>('[aria-selected="true"]'),
    unmount,
  };
}
