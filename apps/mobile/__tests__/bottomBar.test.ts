/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * The compact toolbar, mounted for real.
 *
 * This is the only way to reach the console's verbs on a phone: no keyboard, no
 * hover, no right-click menu. So the claims worth testing are not "the props
 * arrive" but "the result is usable" — which is a claim about the DOM
 * react-native-web produces and the stylesheet it injects, not about the
 * source.
 *
 * Four of them are rules that read as cosmetic and are not:
 *
 *  - **Every target clears `MIN_TOUCH_TARGET` on both axes.** Asserted against
 *    the exported constant rather than against `44`, so the rule cannot pass by
 *    having the same wrong number in two places.
 *  - **The glyphs are hidden from assistive tech and the labels are not.** A
 *    toolbar of bare glyphs announces as punctuation, and here there is no
 *    second route to the command.
 *  - **A disabled action is still in the tree, with its label.** Positions on
 *    this bar are fixed and people aim by position; an item that disappears
 *    moves every other item under a thumb already moving.
 *  - **The bar adds no bottom padding.** `AppFrame` already applies
 *    `insets.bottom` to the slot, so padding here would be double — which is
 *    why the insets are mocked to a *notched* phone below rather than to zero.
 *    Zero insets would make this test pass with the bug present.
 *
 * ## What this can and cannot assert
 *
 * jsdom performs no layout, so this is a render test, not a layout test. It can
 * resolve the injected stylesheet — `min-width`, `height` and `padding-bottom`
 * are real assertions — but it cannot tell you the six targets actually sit
 * side by side above the home indicator on a 390pt screen. That was checked in
 * a browser.
 *
 * ## Three jsdom facts this file depends on
 *
 *  - `useWindowDimensions` does not read `window.innerWidth`. react-native-web
 *    measures `document.documentElement.clientWidth`, which **jsdom reports as
 *    0**, and caches it until a `resize` invalidates it — so a mount happens at
 *    an explicit stubbed width.
 *  - react-native-web expands the `overflow` shorthand into `overflow-x` /
 *    `overflow-y`; the shorthand resolves to `""`. Ask for the axis.
 *  - `Modal` portals into `document.body`, so a root left mounted by a test
 *    that threw is found by the *next* test's queries. Every root is torn down
 *    in `afterEach`, which turns one real failure into one failure rather than
 *    six — or, worse, into a pass.
 */

// The bar draws no insets of its own, which is the thing being asserted. A
// provider would be a second component under test; the insets are the
// platform's business. Non-zero on purpose: see the file comment.
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

// Imported after the mock, which `jest.mock` hoists above it anyway.
const { BottomBar, MIN_TOUCH_TARGET } =
  require("../features/console/BottomBar") as typeof import("../features/console/BottomBar");
const { layout } =
  require("../features/design/tokens") as typeof import("../features/design/tokens");
import type { BottomBarAction } from "../features/console/BottomBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */

/** Every root mounted by this file, torn down after each test. */
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
  text: () => string;
  unmount: () => void;
}

function mount(element: ReactElement, width = 390): Mounted {
  // See the file comment: jsdom reports `clientWidth` as 0, and
  // react-native-web caches that until a `resize` invalidates it.
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 844,
    configurable: true,
  });
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  act(() => {
    root.render(element);
  });

  const unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  live.push(unmount);

  const find = (testID: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);

  const need = (testID: string) => {
    const node = find(testID);
    if (node === null) throw new Error(`no element with testID ${testID}`);
    return node;
  };

  return {
    container,
    find,
    need,
    text: () => container.textContent ?? "",
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

/** The resolved value react-native-web actually gave this node. */
function styleOf(node: HTMLElement, property: string): string {
  return window.getComputedStyle(node).getPropertyValue(property);
}

/** `"44px"` → `44`. `""` → `NaN`, which fails a `toBeGreaterThanOrEqual`. */
function px(node: HTMLElement, property: string): number {
  return Number.parseFloat(styleOf(node, property));
}

function action(over: Partial<BottomBarAction> & { id: string }): BottomBarAction {
  return {
    label: `Do ${over.id}`,
    glyph: "•",
    onPress: () => {},
    ...over,
  };
}

/** The Obsidian arrangement this bar is modelled on, as a fixture. */
function toolbar(): BottomBarAction[] {
  return [
    action({ id: "back", label: "Go back", glyph: "‹" }),
    action({ id: "forward", label: "Go forward", glyph: "›" }),
    action({ id: "search", label: "Search notes and commands", glyph: "⌕" }),
    action({ id: "new", label: "New note", glyph: "＋" }),
    action({ id: "tabs", label: "3 notes open", glyph: "▤", badge: 3 }),
    action({ id: "menu", label: "More actions", glyph: "⋯" }),
  ];
}

function mountBar(actions: BottomBarAction[], width = 390): Mounted {
  return mount(createElement(BottomBar, { actions }), width);
}

/* -------------------------------------------------------------------------- */

describe("what is on the bar", () => {
  test("every action is present, named by its label", () => {
    const bar = mountBar(toolbar());

    for (const item of toolbar()) {
      expect(bar.need(`bottom-bar-${item.id}`).getAttribute("aria-label")).toBe(item.label);
    }

    expect(bar.need("bottom-bar").getAttribute("role")).toBe("toolbar");
  });

  test("the glyphs are decorative, and the label is the whole name", () => {
    // Without this the toolbar announces as "‹ › ⌕ ＋ ▤ ⋯" — punctuation — and
    // on a phone there is no menu and no keymap to reach the commands instead.
    const bar = mountBar([action({ id: "search", label: "Search notes", glyph: "⌕" })]);
    const target = bar.need("bottom-bar-search");

    expect(target.textContent).toBe("⌕");
    expect(target.querySelector("[aria-hidden]")?.textContent).toBe("⌕");
    expect(target.getAttribute("aria-label")).toBe("Search notes");
  });

  test("pressing an action calls it, and only it", () => {
    const search = jest.fn<() => void>();
    const menu = jest.fn<() => void>();
    const bar = mountBar([
      action({ id: "search", onPress: search }),
      action({ id: "menu", onPress: menu }),
    ]);

    bar.click("bottom-bar-search");

    expect(search).toHaveBeenCalledTimes(1);
    expect(menu).not.toHaveBeenCalled();
  });
});

describe("a thumb has to be able to hit it", () => {
  test("every target is at least MIN_TOUCH_TARGET on both axes", () => {
    // Asserted against the exported constant, so this cannot pass by having the
    // same wrong number typed into the styles and into the test.
    const bar = mountBar(toolbar());

    for (const item of toolbar()) {
      const target = bar.need(`bottom-bar-${item.id}`);
      expect(px(target, "min-width")).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect(px(target, "min-height")).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    }
  });

  test("the bar is as tall as the frame reserves for it, and taller than the minimum", () => {
    const bar = mountBar(toolbar());

    expect(px(bar.need("bottom-bar"), "height")).toBe(layout.bottomBarHeight);
    expect(layout.bottomBarHeight).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  });

  test("the targets share the width evenly rather than sizing to their glyphs", () => {
    const bar = mountBar(toolbar());

    for (const item of toolbar()) {
      const target = bar.need(`bottom-bar-${item.id}`);
      expect(px(target, "flex-grow")).toBe(1);
      expect(px(target, "flex-basis")).toBe(0);
    }
  });

  test("the bar adds no safe-area padding of its own", () => {
    // `AppFrame` already applies `insets.bottom` to this slot, and the mocked
    // insets above are a notched phone's — so a bar that padded itself would
    // resolve to 34px here rather than 0.
    const bar = mountBar(toolbar());
    expect(px(bar.need("bottom-bar"), "padding-bottom")).toBe(0);
  });
});

describe("an unavailable action", () => {
  test("does not fire, but stays where it was with its label", () => {
    // If it vanished, every action to its right would move under a thumb that
    // is already travelling towards a fixed position.
    const onPress = jest.fn<() => void>();
    const bar = mountBar([
      action({ id: "back", label: "Go back", disabled: true, onPress }),
      action({ id: "forward", label: "Go forward" }),
    ]);

    bar.click("bottom-bar-back");
    expect(onPress).not.toHaveBeenCalled();

    const target = bar.need("bottom-bar-back");
    expect(target.getAttribute("aria-label")).toBe("Go back");
    expect(target.getAttribute("aria-disabled")).toBe("true");
    // Dimmed, not hidden: it is announced, and it holds its place.
    expect(px(target, "opacity")).toBeLessThan(1);
    expect(styleOf(target, "display")).not.toBe("none");
  });

  test("an available action says nothing about being disabled", () => {
    const bar = mountBar([action({ id: "forward", label: "Go forward" })]);
    expect(bar.need("bottom-bar-forward").getAttribute("aria-disabled")).toBeNull();
  });
});

describe("badges and markers", () => {
  test("a count renders as a badge", () => {
    const bar = mountBar([action({ id: "tabs", label: "3 notes open", glyph: "▤", badge: 3 })]);

    expect(bar.need("bottom-bar-tabs-badge").textContent).toBe("3");
    expect(bar.text()).toContain("3");
  });

  test("zero renders no badge at all, rather than a badge saying 0", () => {
    // "0" in a badge reads as a count worth looking at. Nothing open is nothing
    // to show.
    const bar = mountBar([action({ id: "tabs", label: "No notes open", glyph: "▤", badge: 0 })]);

    expect(bar.find("bottom-bar-tabs-badge")).toBeNull();
    expect(bar.need("bottom-bar-tabs").textContent).toBe("▤");
  });

  test("an action with no badge field has no badge", () => {
    const bar = mountBar([action({ id: "menu" })]);
    expect(bar.find("bottom-bar-menu-badge")).toBeNull();
  });

  test("a marker renders a dot, and the label still carries the meaning", () => {
    // The dot is a warning that leaving is lossy, and a warning only sighted
    // people get is not a warning — so the caller puts it in the label too, the
    // way `TabCountButton` does.
    const bar = mountBar([
      action({
        id: "tabs",
        label: "2 notes open, 1 with unsaved changes",
        glyph: "▤",
        badge: 2,
        marker: true,
      }),
    ]);

    const dot = bar.need("bottom-bar-tabs-marker");
    expect(px(dot, "width")).toBeGreaterThan(0);
    // `border-radius` is a shorthand, and jsdom resolves only the longhands —
    // the same expansion that makes `overflow` come back "". Ask for a corner.
    expect(px(dot, "border-top-left-radius")).toBeGreaterThan(0);
    // A dot is not text: it must not be announced as anything.
    expect(dot.textContent).toBe("");
    expect(bar.need("bottom-bar-tabs").getAttribute("aria-label")).toBe(
      "2 notes open, 1 with unsaved changes",
    );
  });

  test("no marker means no dot", () => {
    const bar = mountBar([action({ id: "tabs", badge: 2 })]);
    expect(bar.find("bottom-bar-tabs-marker")).toBeNull();
  });
});

describe("captions", () => {
  test("a title is drawn under the glyph, and hidden from assistive tech", () => {
    // The glyphs are Unicode characters with wildly different optical sizes —
    // measured in Chromium at 19px, `☰` is 17px wide and `⌕` is 10.6 — so a
    // bare-glyph row reads as buttons and a smudge. The caption normalises it.
    // It is aria-hidden because `label` is already the accessible name, and
    // "Search, Search notes" is worse than either alone.
    const bar = mountBar([
      { id: "search", label: "Search notes", title: "Search", glyph: "\u2315", onPress: () => {} },
    ]);

    const caption = bar.find("bottom-bar-search-title");
    expect(caption).not.toBeNull();
    expect(caption!.textContent).toBe("Search");
    expect(caption!.closest("[aria-hidden]")).not.toBeNull();

    // The accessible name is still the long one.
    expect(bar.container.querySelector('[aria-label="Search notes"]')).not.toBeNull();
  });

  test("an action with no title renders none rather than an empty line", () => {
    const bar = mountBar([
      { id: "files", label: "Open the file tree", glyph: "\u2630", onPress: () => {} },
    ]);
    expect(bar.find("bottom-bar-files-title")).toBeNull();
  });
});
