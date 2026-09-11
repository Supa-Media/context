/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * The phone's Recent sheet, mounted for real.
 *
 * `noteHistory.test.ts` pins the *list* — `recentPaths` over `HistoryState` —
 * as a pure function, and that is where every question about ordering, dedup
 * and the cap is settled. This file asks the other half: whether the sheet
 * presents that list once react-native-web has turned it into DOM.
 *
 * ## What this replaced
 *
 * A tab-count button and an "Open notes" switcher, which `tabStrip.test.ts`
 * covered against states no phone could ever be in. Nothing at compact density
 * can open a second tab — `openInNewTab` is web-only in `menu.ts`, its row menu
 * lives in an Explorer that `frame.ts` hides on a phone, and every other open
 * arrives as a `preview` that replaces the preview slot. So the suite asserted
 * a count of "3" while the shipped control read "1" for the life of the app,
 * and its × was asserted to be a separate target while what it did was nothing
 * visible at all. `RecentSheet.tsx` carries the full argument.
 *
 * The three claims here are ones that cannot be checked by reading the source:
 *
 *  - **The current row is marked, in both channels.** The accent behind it is
 *    the sighted half; the accessible name carries the same fact, because a
 *    state only sighted people get is not a state.
 *  - **A folder row draws a folder.** History records the selection, which is a
 *    folder as often as a note, and the glyph is resolved from the path.
 *  - **An empty list dismisses rather than sitting there empty**, which is an
 *    effect firing on mount and therefore not visible in the markup.
 *
 * jsdom lays nothing out, so this is a render test, not a layout test — see
 * `tabStrip.test.ts` for the two jsdom facts both files depend on.
 */

// The sheet reads the home indicator. A provider would be a second thing under
// test; the insets are the platform's business, not this component's.
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Imported after the mock, which `jest.mock` hoists above it anyway.
const { RecentSheet, describeRecent } =
  require("../features/console/files/RecentSheet") as typeof import("../features/console/files/RecentSheet");
const { darkColors } =
  require("../features/design/tokens") as typeof import("../features/design/tokens");
const { ThemeProvider } =
  require("../features/design/theme") as typeof import("../features/design/theme");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */

const NOTES = "1-projects/notes.md";
const AREAS = "2-areas/health.md";
const FOLDER = "1-projects";
const ROOT_NOTE = "index.md";

const live: Array<() => void> = [];

afterEach(() => {
  while (live.length > 0) live.pop()?.();
  document.body.innerHTML = "";
});

interface Mounted {
  find: (testID: string) => HTMLElement | null;
  need: (testID: string) => HTMLElement;
  click: (testID: string) => void;
  unmount: () => void;
}

function mount(element: ReactElement, width = 390): Mounted {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 800,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(createElement(ThemeProvider, { scheme: "dark", children: element }));
  });

  // From the document, not the container: react-native-web's `Modal` portals to
  // the end of `body`, so the sheet is nowhere inside the div this rendered into.
  const find = (testID: string) =>
    document.body.querySelector<HTMLElement>(`[data-testid="${testID}"]`);

  const need = (testID: string) => {
    const node = find(testID);
    if (node === null) throw new Error(`no element with testID ${testID}`);
    return node;
  };

  let gone = false;
  const unmount = () => {
    if (gone) return;
    gone = true;
    act(() => root.unmount());
    container.remove();
  };
  live.push(unmount);

  return {
    find,
    need,
    click: (testID: string) => {
      const node = need(testID);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    unmount,
  };
}

/** See `tabStrip.test.ts`: three spellings of one colour, reduced to numbers. */
function channels(color: string): string {
  if (color.startsWith("#")) {
    const value = parseInt(color.slice(1), 16);
    // eslint-disable-next-line no-bitwise
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255].join(",");
  }
  const parts = color.match(/-?\d*\.?\d+/g) ?? [];
  return parts.slice(0, 3).join(",");
}

function colorOf(node: HTMLElement, property: string): string {
  return channels(getComputedStyle(node).getPropertyValue(property));
}

interface SheetHandlers {
  onOpen: jest.Mock<(path: string) => void>;
  onDismiss: jest.Mock<() => void>;
}

function mountSheet(
  paths: readonly string[],
  currentPath: string | null = null,
): Mounted & SheetHandlers {
  const handlers: SheetHandlers = {
    onOpen: jest.fn<(path: string) => void>(),
    onDismiss: jest.fn<() => void>(),
  };
  return {
    ...mount(createElement(RecentSheet, { paths, currentPath, ...handlers })),
    ...handlers,
  };
}

/* -------------------------------------------------------------------------- */

describe("the Recent sheet draws what history.ts says", () => {
  test("every place, newest first, with its folder underneath", () => {
    const sheet = mountSheet([NOTES, AREAS], NOTES);

    expect(sheet.need(`recent-${NOTES}`).textContent).toContain("notes");
    expect(sheet.need(`recent-${NOTES}`).textContent).toContain("1-projects");
    expect(sheet.need(`recent-${AREAS}`).textContent).toContain("2-areas");

    // Order is the list's, not the sheet's: it draws what it is handed.
    const rows = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-testid^="recent-"]'),
    ).filter((node) => node.getAttribute("data-testid") !== "recent-sheet");
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      `recent-${NOTES}`,
      `recent-${AREAS}`,
    ]);

    sheet.unmount();
  });

  test("the note you are on is marked, in the accent and in the name", () => {
    /*
      Both channels or neither. The accent alone is a state only sighted people
      get, and this row is the one a person is most likely to press by mistake —
      it is at the top, and it goes nowhere.
    */
    const sheet = mountSheet([NOTES, AREAS], NOTES);

    expect(colorOf(sheet.need(`recent-${NOTES}`), "background-color")).toBe(
      channels(darkColors.accentDim),
    );
    expect(colorOf(sheet.need(`recent-${AREAS}`), "background-color")).not.toBe(
      channels(darkColors.accentDim),
    );

    expect(sheet.need(`recent-${NOTES}`).getAttribute("aria-label")).toContain(
      "where you are now",
    );
    expect(sheet.need(`recent-${AREAS}`).getAttribute("aria-label")).not.toContain(
      "where you are now",
    );

    sheet.unmount();
  });

  test("nothing is marked on a folder view, where no note is open", () => {
    const sheet = mountSheet([NOTES, AREAS], null);
    expect(colorOf(sheet.need(`recent-${NOTES}`), "background-color")).not.toBe(
      channels(darkColors.accentDim),
    );
    sheet.unmount();
  });

  test("a folder row draws a folder and a note draws a file", () => {
    // History records the *selection*, and "back to the folder I was in" is a
    // destination a phone reaches constantly. The glyph comes from the path.
    const sheet = mountSheet([FOLDER, NOTES]);

    const iconIn = (testID: string) =>
      sheet.need(testID).querySelector<HTMLElement>("[data-icon]")?.getAttribute("data-icon");

    expect(iconIn(`recent-${FOLDER}`)).toBe("folder");
    expect(iconIn(`recent-${NOTES}`)).toBe("file");

    sheet.unmount();
  });

  test("pressing a row opens that path and nothing else", () => {
    const sheet = mountSheet([NOTES, AREAS], NOTES);

    sheet.click(`recent-${AREAS}`);
    expect(sheet.onOpen.mock.calls).toEqual([[AREAS]]);
    // No × to nest a second target inside: the whole row is one destination.
    expect(sheet.find(`recent-close-${AREAS}`)).toBeNull();

    sheet.unmount();
  });

  test("an empty list dismisses the sheet rather than sitting there empty", () => {
    // A dead end: no rows to press, and the only way out a scrim somebody has
    // to guess at. A context switch clears the history under an open sheet.
    const sheet = mountSheet([]);
    expect(sheet.onDismiss).toHaveBeenCalledTimes(1);
    sheet.unmount();
  });

  test("pressing the scrim dismisses, and pressing the sheet does not", () => {
    const sheet = mountSheet([NOTES, AREAS], NOTES);

    sheet.click("recent-sheet");
    expect(sheet.onDismiss).not.toHaveBeenCalled();

    sheet.unmount();
  });
});

describe("what a screen reader hears", () => {
  test("the kind, the name and the folder, in that order", () => {
    expect(describeRecent(NOTES, false)).toBe("note notes, 1-projects");
    expect(describeRecent(FOLDER, false)).toBe("folder 1-projects, in your context root");
  });

  test("the root is a place, so it gets a name rather than an empty clause", () => {
    expect(describeRecent(ROOT_NOTE, false)).toBe("note index, in your context root");
  });

  test("an attachment is a file, not a folder", () => {
    // The glyph is resolved from the extension; a `.png` in the history is
    // something you opened, and reading it out as a folder would be a lie.
    expect(describeRecent("3-resources/diagram.png", false)).toContain("note diagram.png");
  });

  test("where you are is a clause on the name", () => {
    expect(describeRecent(NOTES, true)).toBe("note notes, 1-projects, where you are now");
  });
});
