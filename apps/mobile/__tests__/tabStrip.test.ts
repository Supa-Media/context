/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * The tab strip, mounted for real.
 *
 * `fileTabs.test.ts` pins the *model* — `tabsReducer`, `tabLabel`, `dirtyCount`
 * — as pure functions, and that is where every question about what a gesture
 * should do is settled. This file asks the other half of the question: whether
 * the component actually presents that model, once react-native-web has turned
 * it into DOM.
 *
 * **The phone half used to live here and no longer exists.** A tab-count button
 * and a switcher sheet were tested in this file against a state no phone could
 * ever reach — nothing at that density can open a second tab — so the count was
 * asserted at "3" in jsdom and read "1" for the whole life of the app. A phone
 * gets `RecentSheet` now; `recentSheet.test.ts` is its render test.
 *
 * Four of the assertions here are about things that cannot be checked by reading
 * the source, because each one is a claim about the *result* of a style cascade
 * or an event path rather than about a prop:
 *
 *  - **The × does not also activate the tab.** This is the bug that a tab strip
 *    gets wrong, and it gets it wrong by nesting: a close button inside the
 *    pressable that opens the note means one click fires both, so closing a tab
 *    first switches to it. The two are siblings here precisely so that cannot
 *    happen, and "cannot happen" is worth an assertion because the fix is one
 *    careless refactor from being undone.
 *  - **The strip does not wrap.** A second row of tabs reflows the first, moving
 *    every tab out from under a pointer already travelling towards one.
 *  - **A preview tab is italic.** The slant is the entire signal that the next
 *    single click will replace this tab rather than add one.
 *  - **A dirty tab shows the dot instead of the ×**, in the same box, so aiming
 *    at a close button never lands on a note with an unsaved draft.
 *
 * ## What this can and cannot assert
 *
 * jsdom lays nothing out, so this is a **render test, not a layout test**. It
 * resolves react-native-web's injected stylesheet, which makes `flex-wrap`,
 * `font-style` and the accent border real assertions; it cannot tell you the
 * strip scrolls smoothly or that a 180px label truncates where you would like.
 * Those were checked in a browser.
 *
 * Two jsdom facts this file depends on, both of which cost an afternoon to find:
 *
 *  - `useWindowDimensions` does not read `window.innerWidth`. react-native-web's
 *    `Dimensions` measures `document.documentElement.clientWidth`, which **jsdom
 *    reports as 0**, so a component must be mounted at an explicit width by
 *    stubbing that property and dispatching a `resize`.
 *  - react-native-web expands the `overflow` shorthand into `overflow-x` and
 *    `overflow-y`, so the shorthand itself resolves to `""`. Ask for the axis.
 */

const { TabStrip } =
  require("../features/console/files/TabStrip") as typeof import("../features/console/files/TabStrip");
const { emptyTabs, tabsReducer } =
  require("../features/console/files/tabs") as typeof import("../features/console/files/tabs");
const { darkColors } =
  require("../features/design/tokens") as typeof import("../features/design/tokens");
const { ThemeProvider } =
  require("../features/design/theme") as typeof import("../features/design/theme");
import type { TabsState } from "../features/console/files/tabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */

const NOTES = "1-projects/notes.md";
const PLAN = "1-projects/plan.md";
const AREAS = "2-areas/health.md";

/** Build a state through the real reducer, so no test invents an impossible one. */
function openTabs(...paths: readonly string[]): TabsState {
  return paths.reduce<TabsState>(
    (state, path) => tabsReducer(state, { type: "opened", path, mode: "pinned" }),
    emptyTabs,
  );
}

/**
 * Every root mounted by this file, torn down after each test.
 *
 * Not housekeeping. `find` searches the whole document (see below), so a test
 * that throws before its own `unmount` leaves a live React root in `body` that
 * the *next* test then finds instead of its own — which turns one real failure
 * into six confusing ones and, worse, can turn a real failure into a pass.
 */
const live: Array<() => void> = [];

afterEach(() => {
  while (live.length > 0) live.pop()?.();
  document.body.innerHTML = "";
});

interface Mounted {
  container: HTMLElement;
  find: (testID: string) => HTMLElement | null;
  need: (testID: string) => HTMLElement;
  click: (testID: string) => void;
  unmount: () => void;
}

function mount(element: ReactElement, width = 900): Mounted {
  // See the file comment: jsdom reports `clientWidth` as 0, and react-native-web
  // caches that until a `resize` invalidates it.
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

  // Queried from the document rather than from the container: the strip is
  // inside it, but `FocusRing` and friends are free to portal, and a query that
  // only ever worked because nothing did is a trap for the next component. Each
  // test unmounts, so nothing accumulates between them.
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
    container,
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

/**
 * Compare a resolved colour to a token without caring how it was spelled.
 *
 * Three spellings turn up for the same colour in this one file:
 * react-native-web normalises what it is given to `rgba(59,130,246,1.00)`, jsdom
 * re-serialises the properties it parses to `rgb(59, 130, 246)`, and which of
 * the two comes back depends on the property being read — `background-color` is
 * one jsdom understands, `border-top-color` is not. So both sides are reduced to
 * three numbers and compared as numbers.
 */
function channels(color: string): string {
  if (color.startsWith("#")) {
    const value = parseInt(color.slice(1), 16);
    // eslint-disable-next-line no-bitwise
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255].join(",");
  }
  const parts = color.match(/-?\d*\.?\d+/g) ?? [];
  return parts.slice(0, 3).join(",");
}

/** The resolved value of one CSS property on an element, as three channels. */
function colorOf(node: HTMLElement, property: string): string {
  return channels(getComputedStyle(node).getPropertyValue(property));
}

interface StripHandlers {
  onActivate: jest.Mock<(path: string) => void>;
  onClose: jest.Mock<(path: string) => void>;
  onCloseOthers: jest.Mock<(path: string) => void>;
  onReopen: jest.Mock<() => void>;
}

function mountStrip(state: TabsState): Mounted & StripHandlers {
  const handlers: StripHandlers = {
    onActivate: jest.fn<(path: string) => void>(),
    onClose: jest.fn<(path: string) => void>(),
    onCloseOthers: jest.fn<(path: string) => void>(),
    onReopen: jest.fn<() => void>(),
  };
  return { ...mount(createElement(TabStrip, { state, ...handlers })), ...handlers };
}

/* -------------------------------------------------------------------------- */

describe("the tab strip draws what tabs.ts says", () => {
  test("tabs render left to right in strip order, with the active one distinguished", () => {
    const state = openTabs(NOTES, PLAN, AREAS);
    // `opened` activates what it opened, so the third is active; move it.
    const strip = mountStrip(tabsReducer(state, { type: "activated", path: PLAN }));

    const labels = Array.from(
      strip.need("tab-strip-track").querySelectorAll('[data-testid^="tab-open-"]'),
    ).map((node) => node.textContent);
    expect(labels).toEqual(["notes", "plan", "health"]);

    // Distinguished two ways, and both matter: the accent edge is what a person
    // sees, `aria-selected` is what everybody else gets.
    const active = strip.need(`tab-${PLAN}`);
    const idle = strip.need(`tab-${NOTES}`);
    expect(colorOf(active, "border-top-color")).toBe(channels(darkColors.accent));
    expect(colorOf(idle, "border-top-color")).not.toBe(channels(darkColors.accent));
    expect(colorOf(active, "background-color")).toBe(channels(darkColors.surface));
    expect(colorOf(idle, "background-color")).toBe(channels(darkColors.surface2));

    expect(strip.need(`tab-open-${PLAN}`).getAttribute("aria-selected")).toBe("true");
    expect(strip.need(`tab-open-${NOTES}`).getAttribute("aria-selected")).toBe("false");

    strip.unmount();
  });

  test("a preview tab is italic and a pinned one is not", () => {
    const state = tabsReducer(openTabs(NOTES), { type: "opened", path: PLAN, mode: "preview" });
    const strip = mountStrip(state);

    const previewLabel = strip.need(`tab-open-${PLAN}`).firstElementChild as HTMLElement;
    const pinnedLabel = strip.need(`tab-open-${NOTES}`).firstElementChild as HTMLElement;
    expect(getComputedStyle(previewLabel).fontStyle).toBe("italic");
    expect(getComputedStyle(pinnedLabel).fontStyle).not.toBe("italic");

    strip.unmount();
  });

  test("a dirty tab shows the dot rather than the ×, in the same box", () => {
    const strip = mountStrip(tabsReducer(openTabs(NOTES, PLAN), { type: "edited", path: NOTES }));

    const dirtyClose = strip.need(`tab-close-${NOTES}`);
    expect(strip.find(`tab-dot-${NOTES}`)).not.toBeNull();
    expect(dirtyClose.textContent).not.toContain("×");
    // The dot is *inside* the close button, not beside it — that is the whole
    // point. A dot rendered as a sibling would satisfy "shows a dot" and would
    // still have moved the × sideways.
    expect(dirtyClose.contains(strip.need(`tab-dot-${NOTES}`))).toBe(true);

    // The × is drawn now rather than typed, so it is asserted by name — see
    // `design/components/Icon`, which carries `data-icon` for exactly this.
    const cleanClose = strip.need(`tab-close-${PLAN}`);
    expect(cleanClose.querySelector('[data-icon="close"]')).not.toBeNull();
    expect(strip.find(`tab-dot-${PLAN}`)).toBeNull();

    // …and it is still a close button while it is wearing a dot.
    expect(dirtyClose.getAttribute("aria-label")).toContain("Close");
    expect(dirtyClose.getAttribute("aria-label")).toContain("unsaved");

    strip.unmount();
  });

  test("clicking a tab activates it", () => {
    const strip = mountStrip(openTabs(NOTES, PLAN));

    strip.click(`tab-open-${NOTES}`);
    expect(strip.onActivate.mock.calls).toEqual([[NOTES]]);
    expect(strip.onClose).not.toHaveBeenCalled();

    strip.unmount();
  });

  test("clicking the × closes the tab and does NOT also activate it", () => {
    // The bug this guards: a close button nested inside the pressable that opens
    // the note fires both handlers from one click, so closing a background tab
    // switches to it on the way out — and with an unsaved draft in the one you
    // were in, that is a jump you did not ask for.
    const strip = mountStrip(openTabs(NOTES, PLAN));

    strip.click(`tab-close-${NOTES}`);
    expect(strip.onClose.mock.calls).toEqual([[NOTES]]);
    expect(strip.onActivate).not.toHaveBeenCalled();

    // And the structural claim the behaviour rests on, asserted separately.
    //
    // React Native's responder negotiation happens to spare a *nested* close
    // button too — the innermost responder wins, so the handler above would not
    // fire either way — which means the behavioural assertion alone would go on
    // passing after somebody nested the two. It is the containment that must
    // never come back: it is the arrangement where a plain DOM `onClick`, a
    // keyboard activation, or the next version of the responder system fires
    // both handlers from one press.
    expect(strip.need(`tab-open-${NOTES}`).contains(strip.need(`tab-close-${NOTES}`))).toBe(false);

    strip.unmount();
  });

  test("the strip scrolls sideways and never wraps to a second row", () => {
    const strip = mountStrip(openTabs(NOTES, PLAN, AREAS));

    // react-native-web expands `overflow`, so the shorthand is `""` here and
    // the axis is the only thing worth asking about.
    const scroller = getComputedStyle(strip.need("tab-strip-scroller"));
    expect(["auto", "scroll"]).toContain(scroller.overflowX);

    const track = getComputedStyle(strip.need("tab-strip-track"));
    expect(track.flexWrap).toBe("nowrap");
    expect(track.flexDirection).toBe("row");

    strip.unmount();
  });

  test("no tabs means no strip, rather than an empty bar", () => {
    const strip = mountStrip(emptyTabs);
    expect(strip.find("tab-strip")).toBeNull();
    strip.unmount();
  });
});
