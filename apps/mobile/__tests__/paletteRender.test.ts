/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
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
  require("../features/design/components/Palette") as typeof import("../features/design/components/Palette");
const { layout, colors } =
  require("../features/design/tokens") as typeof import("../features/design/tokens");
type PaletteItem = import("../features/console/files/palette").PaletteItem;

/* -------------------------------------------------------------------------- */

/**
 * Deliberately *not* in ranked order.
 *
 * "New note" is first, so "typing reorders the list" is a real claim: with an
 * empty query the command is row 0 (an untyped palette shows input order), and
 * after `note` it has to drop below the note whose name starts with it.
 */
const ITEMS: PaletteItem[] = [
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

const PHONE = 390;
const DESKTOP = 1280;

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
function rgb(hex: string): string {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

interface Mounted {
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

function mount(
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
      createElement(Palette, {
        items: ITEMS,
        placeholder: "Search notes and commands",
        emptyHeading: "Recent",
        noMatchMessage: "Nothing here matches. Try fewer letters.",
        onChoose: (item) => chosen.push(item),
        onDismiss: () => {
          dismissed += 1;
        },
        ...props,
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

/* -------------------------------------------------------------------------- */

describe("the query drives the list", () => {
  test("an untyped palette shows every item, in the order it was given", () => {
    const palette = mount(DESKTOP);
    expect(palette.rowLabels()).toHaveLength(ITEMS.length);
    expect(palette.rowLabels()[0]).toContain("New note");
    expect(palette.find("palette-heading")?.textContent).toBe("Recent");
    palette.unmount();
  });

  test("typing filters the list and reorders what survives", () => {
    const palette = mount(DESKTOP);
    palette.type("note");

    const labels = palette.rowLabels();
    // Filtered: the four items with no `note` subsequence in them are gone.
    expect(labels).toHaveLength(2);
    // Reordered: the command was row 0 a moment ago and is now below the note
    // whose name actually starts with what was typed.
    expect(labels[0]).toContain("notes-on-storage.md");
    expect(labels[1]).toContain("New note");

    palette.unmount();
  });

  test("a query that matches nothing says so, rather than showing an empty box", () => {
    const palette = mount(DESKTOP);
    palette.type("zzzzq");

    expect(palette.rowLabels()).toHaveLength(0);
    expect(palette.find("palette-empty")?.textContent).toBe(
      "Nothing here matches. Try fewer letters.",
    );

    palette.unmount();
  });
});

describe("the matched characters are emphasised", () => {
  test("`Match.ranges` becomes real nodes, weighted apart from the rest", () => {
    const palette = mount(DESKTOP);
    palette.type("note");

    const topRow = palette.find("palette-row-0")!;
    const marks = [...topRow.querySelectorAll<HTMLElement>('[data-testid="palette-mark"]')];

    // `notes-on-storage.md` matches at its first four characters, so the run
    // is exactly what was typed — not merely "some node exists".
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.map((mark) => mark.textContent).join("")).toBe("note");

    // …and it has to *look* different, or the ranges are decoration.
    const emphasis = window.getComputedStyle(marks[0]);
    expect(emphasis.fontWeight).toBe("600");
    expect(emphasis.color).toBe(rgb(colors.text));

    palette.unmount();
  });

  test("an untyped palette emphasises nothing", () => {
    // `rank("")` returns empty ranges, and a component that highlighted
    // anything here would be inventing a match.
    const palette = mount(DESKTOP);
    expect(palette.all('[data-testid="palette-mark"]')).toHaveLength(0);
    palette.unmount();
  });
});

describe("the keyboard", () => {
  test("the top match is selected before anything is pressed", () => {
    const palette = mount(DESKTOP);
    expect(palette.selectedRow()?.dataset.testid).toBe("palette-row-0");
    palette.unmount();
  });

  test("↓ and ↑ move the selection, and it wraps", () => {
    const palette = mount(DESKTOP);

    palette.press("ArrowDown");
    expect(palette.selectedRow()?.dataset.testid).toBe("palette-row-1");

    palette.press("ArrowDown");
    expect(palette.selectedRow()?.dataset.testid).toBe("palette-row-2");

    palette.press("ArrowUp");
    expect(palette.selectedRow()?.dataset.testid).toBe("palette-row-1");

    // Up from the top lands on the last row rather than stopping dead.
    palette.press("ArrowUp");
    palette.press("ArrowUp");
    expect(palette.selectedRow()?.dataset.testid).toBe(`palette-row-${ITEMS.length - 1}`);

    palette.unmount();
  });

  test("Enter chooses the selected row, not the first one", () => {
    const palette = mount(DESKTOP);
    palette.type("note");

    // Two matches, and the highlight is deliberately moved off the top one.
    palette.press("ArrowDown");
    palette.press("Enter");

    expect(palette.chosen).toHaveLength(1);
    expect(palette.chosen[0].id).toBe("cmd:new-note");

    palette.unmount();
  });

  test("Escape dismisses", () => {
    const palette = mount(DESKTOP);
    palette.press("Escape");
    expect(palette.dismissals()).toBe(1);
    expect(palette.chosen).toHaveLength(0);
    palette.unmount();
  });

  test("a shrinking result set never leaves Enter pointing at nothing", () => {
    const palette = mount(DESKTOP);

    // Walk to the bottom of the full list, then type something that leaves one
    // row. Without a clamp the selection is off the end and Enter does nothing.
    palette.press("ArrowUp");
    palette.type("tfm");

    expect(palette.rowLabels()).toHaveLength(1);
    palette.press("Enter");
    expect(palette.chosen.map((item) => item.id)).toEqual([
      "1-projects/together-financial-management.md",
    ]);

    palette.unmount();
  });
});

describe("choosing with a pointer or a thumb", () => {
  test("tapping a row chooses that row", () => {
    const palette = mount(PHONE);
    palette.click("palette-row-2");
    expect(palette.chosen.map((item) => item.id)).toEqual(["3-resources/notes-on-storage.md"]);
    palette.unmount();
  });

  test("the scrim dismisses on a pointer layout", () => {
    const palette = mount(DESKTOP);
    palette.click("palette-scrim");
    expect(palette.dismissals()).toBe(1);
    palette.unmount();
  });

  test("Cancel dismisses on a phone", () => {
    const palette = mount(PHONE);
    palette.click("palette-cancel");
    expect(palette.dismissals()).toBe(1);
    palette.unmount();
  });
});

describe("one component, two presentations", () => {
  test("a phone gets the full-screen sheet and no floating panel", () => {
    const palette = mount(PHONE);

    expect(palette.find("palette-sheet")).not.toBeNull();
    expect(palette.find("palette-panel")).toBeNull();
    expect(palette.find("palette-scrim")).toBeNull();
    // Cancel is the only way out where there is no Escape key.
    expect(palette.find("palette-cancel")).not.toBeNull();

    palette.unmount();
  });

  test("a desktop gets the floating panel and no sheet", () => {
    const palette = mount(DESKTOP);

    expect(palette.find("palette-panel")).not.toBeNull();
    expect(palette.find("palette-sheet")).toBeNull();
    expect(palette.find("palette-scrim")).not.toBeNull();

    palette.unmount();
  });

  test("the switch is the layout token, not a number typed into the component", () => {
    const narrow = mount(layout.narrowBreakpoint - 1);
    expect(narrow.find("palette-sheet")).not.toBeNull();
    narrow.unmount();

    const wide = mount(layout.narrowBreakpoint);
    expect(wide.find("palette-panel")).not.toBeNull();
    wide.unmount();
  });

  test("a touch row clears the 44pt minimum target", () => {
    const palette = mount(PHONE);
    const row = palette.find("palette-row-0")!;
    const height = Number.parseFloat(window.getComputedStyle(row).height);

    expect(Number.isNaN(height)).toBe(false);
    expect(height).toBeGreaterThanOrEqual(44);

    palette.unmount();
  });

  test("the panel is bounded, so a wide window does not stretch it edge to edge", () => {
    const palette = mount(DESKTOP);
    const panel = palette.find("palette-panel")!;
    expect(window.getComputedStyle(panel).maxWidth).toBe("560px");
    palette.unmount();
  });

  test("both presentations draw the same row", () => {
    // The row is the one piece that must not fork: it carries the highlight.
    const phone = mount(PHONE);
    phone.type("note");
    const onPhone = phone
      .find("palette-row-0")!
      .querySelectorAll('[data-testid="palette-mark"]').length;
    phone.unmount();

    const desktop = mount(DESKTOP);
    desktop.type("note");
    const onDesktop = desktop
      .find("palette-row-0")!
      .querySelectorAll('[data-testid="palette-mark"]').length;
    desktop.unmount();

    expect(onPhone).toBe(onDesktop);
    expect(onPhone).toBeGreaterThan(0);
  });
});
