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
 *  - **The icons are hidden from assistive tech and the labels are not.** An
 *    icon carries no text at all, so a toolbar that leant on it would announce
 *    as six unnamed buttons, and here there is no second route to the command.
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
 * **And "it is a render test" was doing more work than it should have been.**
 * The seventh key overflowed the pill on every phone narrower than 381pt and
 * nothing here could see it: `min-width` is the constant the stylesheet types,
 * so it reads 44 at any viewport and in any amount of overflow, and the one
 * arithmetic test divided a width by seven at a single width — and got that
 * wrong too, by leaving the separator's own point out of the divisor. What was
 * missing is not a browser: it is *solving* the flex declarations this render
 * produces. `bottomRowWidth.test.ts` does that, across a table of real device
 * widths. Rules that are only *declared* here are asserted here; whether a row
 * of them fits is asserted there.
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
const { layout, bottomBarGeometry } =
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
    icon: "more",
    onPress: () => {},
    ...over,
  };
}

/** The Obsidian arrangement this bar is modelled on, as a fixture. */
function toolbar(): BottomBarAction[] {
  return [
    action({ id: "back", label: "Go back", icon: "arrowLeft" }),
    action({ id: "forward", label: "Go forward", icon: "arrowRight" }),
    action({ id: "search", label: "Search this context", icon: "search" }),
    action({ id: "new", label: "New note", icon: "plus" }),
    action({ id: "tabs", label: "3 notes open", icon: "file", badge: 3 }),
    action({ id: "menu", label: "More actions", icon: "more" }),
  ];
}

/**
 * The same row plus the seventh key: one destination, in the last position,
 * behind a separator.
 *
 * Named for its shape rather than for what it opens, because `BottomBar` does
 * not know either — see the file comment there. A fixture that said "meetings"
 * would be this test file deciding a placement that belongs to the layout.
 */
function sevenKeys(): BottomBarAction[] {
  return [
    ...toolbar(),
    action({ id: "elsewhere", label: "Go somewhere else", icon: "mic", separated: true }),
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

  test("the icon is decorative, and the label is the whole name", () => {
    // An icon is drawn from Views and contributes no text at all, so a target
    // carrying one and nothing else has *no* accessible name unless the
    // control supplies it — and on a phone there is no menu and no keymap to
    // reach the command instead. The icon is also hidden on both platforms'
    // terms: `aria-hidden` for the web tree, `accessibilityElementsHidden`
    // (which react-native-web renders as nothing, and iOS reads) for native.
    const bar = mountBar([action({ id: "search", label: "Search notes", icon: "search" })]);
    const target = bar.need("bottom-bar-search");

    expect(target.textContent).toBe("");
    expect(target.querySelector("[aria-hidden]")).not.toBeNull();
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

  /**
   * Evenly sized, by sharing the bar rather than by each setting a width.
   *
   * The bar's width is the screen's now, less `layout.bottomBarInset` either
   * side — see the file comment for why the *inset* is the measurement and the
   * width is what follows from it — so the targets divide what is inside it.
   * `flexBasis` is the size each wants; `minWidth` is the floor none may be
   * squeezed below. What has to hold under every arrangement is that no target
   * is the size of its icon, which is what this asserts.
   */
  test("every target shares the bar evenly, and none is the size of its icon", () => {
    const bar = mountBar(toolbar());

    for (const item of toolbar()) {
      const target = bar.need(`bottom-bar-${item.id}`);
      expect(px(target, "flex-basis")).toBe(layout.bottomBarTarget);
      expect(px(target, "flex-grow")).toBe(1);
    }
    // And the share each wants is still above the floor, which is the rule the
    // width has to keep rather than replace.
    expect(layout.bottomBarTarget).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  });

  /**
   * **What 52 *is*, which nothing asserted.**
   *
   * `layout.bottomBarTarget` had two checks on it and neither could see its
   * value: `flex-basis` was compared against the token itself, which is true of
   * any number, and the floor check passes for anything at or above 44. So
   * `52 → 60` survived the whole suite — a bar whose natural width is 384
   * where the reference measures 336, drawn on every phone.
   *
   * The token's own comment says what it is: *"52 is what six targets plus
   * `bottomBarPad` either side need to fill the 336pt the reference
   * measures"* — 440pt of glass with 52pt of note showing each side. That is an
   * identity between three tokens and one measurement, so it is asserted as
   * one. It is the *natural* width and not the drawn one: `bottomBarInset` is
   * 24 now and the pill is wider than 336, which is what a seventh key cost and
   * is `seven targets clear the touch floor on a 390pt phone` below.
   *
   * SABOTAGE: `bottomBarTarget: 52 → 60`. MEASURED: this test fails; before it,
   * all 3343 passed.
   */
  test("a target's natural width is the reference's own bar, divided", () => {
    /** The pill Obsidian draws on a 440pt screen: x=52.0 to x=387.7. */
    const REFERENCE_BAR = 336;
    /** Six note verbs, which is what the reference shows. */
    const REFERENCE_KEYS = 6;

    expect(REFERENCE_KEYS * layout.bottomBarTarget + 2 * layout.bottomBarPad).toBe(REFERENCE_BAR);
    // …and 336 is 440 less the sliver of note the measurement is of, which is
    // the number `bottomBarInset` used to be and the reason it was that.
    expect(440 - 2 * 52).toBe(REFERENCE_BAR);
  });

  test("the bar fills the slot rather than sizing itself", () => {
    const bar = mountBar(toolbar(), 440);
    const style = window.getComputedStyle(bar.need("bottom-bar"));

    // The inset is the frame's (`AppFrame`'s `bottomBar` slot,
    // `layout.bottomBarInset`), and `appFrameRender.test.ts` is where that
    // number is asserted against the frame. The pass before this reached the
    // width through the targets — `alignSelf: "center"` over six fixed boxes —
    // which is only the reference's geometry on a route that happens to offer
    // six actions: a device found the pill 78pt in from an edge on a context
    // with no New note.
    expect(style.alignSelf).toBe("stretch");
    expect(px(bar.need("bottom-bar"), "padding-left")).toBe(layout.bottomBarPad);
  });

  /**
   * **The seventh key fits, and the arithmetic is done here rather than quoted.**
   *
   * This test used to pin `layout.bottomBarInset` to 52 and check that six
   * targets plus the bar's padding came to the reference's 336 on a 440pt
   * screen. Both halves have moved: the inset is 24, and the row is seven keys
   * — six verbs and one destination — because a phone has no rail to reach the
   * app's other places through any more (`features/app/frame.ts`).
   *
   * **And it had the separator's point missing from the divisor**, which is why
   * it read `318 / 7` and passed at `toBeCloseTo(45.43, 2)`: the rule is a
   * `flexShrink: 0` child of the same row, so seven targets divide 317. Every
   * term comes from `bottomBarGeometry` now, so the expectation cannot be a
   * comment reproduced as an assertion.
   *
   * The `52` case is computed alongside as the control — under the floor for
   * seven keys and for six — which is what "the sliver of note is what bought
   * the seventh key" means as a measurement rather than as a claim.
   *
   * SABOTAGE: `bottomBarInset` back to 52. Fails here, and in
   * `bottomRowWidth.test.ts`, and nowhere else.
   */
  test("seven targets clear the touch floor on a 390pt phone, and at 52 they did not", () => {
    // The narrow case the arithmetic was signed off at. The reference is 440,
    // and every width *below* this one is `bottomRowWidth.test.ts`, which is
    // where the bug this file could not see actually lived.
    const PHONE = 390;
    const inside = (inset: number) =>
      PHONE - inset * 2 - layout.bottomBarPad * 2 - layout.bottomBarRule;

    // 390 − 2×24 = 342 pill; − 2×12 padding = 318; − 1 rule = 317; ÷ 7 = 45.29.
    expect(PHONE - layout.bottomBarInset * 2).toBe(342);
    expect(inside(layout.bottomBarInset)).toBe(317);
    const seven = inside(layout.bottomBarInset) / 7;
    expect(seven).toBeCloseTo(45.29, 2);
    expect(seven).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    // The same number, from the function the bar actually lays itself out with.
    expect(bottomBarGeometry(PHONE, 7, 1).target).toBeCloseTo(seven, 9);

    // The control: at the inset this replaced, neither row fitted.
    // 390 − 2×52 = 286; − 24 = 262; − 1 = 261; ÷ 7 = 37.29, ÷ 6 = 43.5.
    expect(inside(52)).toBe(261);
    expect(inside(52) / 7).toBeCloseTo(37.29, 2);
    expect(inside(52) / 7).toBeLessThan(MIN_TOUCH_TARGET);
    expect(inside(52) / 6).toBeCloseTo(43.5, 2);
    expect(inside(52) / 6).toBeLessThan(MIN_TOUCH_TARGET);
  });

  test("and the reference's own screen still holds seven", () => {
    // 440 is where every measurement in `BottomBar`'s header was taken. The
    // narrow case above is what binds, so this is a floor check rather than a
    // second specification.
    const inside =
      440 - layout.bottomBarInset * 2 - layout.bottomBarPad * 2 - layout.bottomBarRule;
    expect(inside / 7).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  });

  /**
   * **How many keys there are, which nothing asserted.**
   *
   * `expect(toolbar()).toHaveLength(6)` was deleted when the row grew and was
   * not replaced, so the fixtures the width tests run against could quietly
   * become five keys and every one of those tests would go green on a row that
   * is not the row. The count *is* the width problem — six fit at 375 and seven
   * do not — so it is asserted where it is used.
   *
   * What the seventh key **opens** is not asserted here and must not be: this
   * file mounts `BottomBar`, which deliberately does not know. The console's
   * real row, and the meeting key at the end of it, are pinned in
   * `bottomRowWidth.test.ts`.
   */
  test("the fixtures really are six verbs, and six verbs plus one destination", () => {
    expect(toolbar()).toHaveLength(6);
    expect(toolbar().some((item) => item.separated === true)).toBe(false);

    const seven = sevenKeys();
    expect(seven).toHaveLength(7);
    expect(seven.slice(0, 6).map((item) => item.id)).toEqual(toolbar().map((item) => item.id));
    // The destination is last, and it is the only thing that opens a group.
    expect(seven.filter((item) => item.separated === true).map((item) => item.id)).toEqual([
      seven[6].id,
    ]);
  });

  test("a seven-key row draws seven targets, each above the floor", () => {
    // The arithmetic above is about tokens; this is about what was rendered
    // with a seventh action actually on the bar.
    //
    // **`min-width` is not evidence on its own** — it is the literal constant
    // in the stylesheet and reads 44 at any width, with any number of actions,
    // in any amount of overflow. It is asserted here because the floor being
    // *declared* is a real rule; whether the row honours it is a layout solve,
    // and that is `bottomRowWidth.test.ts`.
    const bar = mountBar(sevenKeys());
    expect(bar.need("bottom-bar").children).toHaveLength(8); // seven keys, one rule
    for (const item of sevenKeys()) {
      const target = bar.need(`bottom-bar-${item.id}`);
      expect(px(target, "min-width")).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect(px(target, "min-height")).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    }
  });

  /**
   * A full pill, not a rounded rectangle.
   *
   * The reference's extent narrows symmetrically at both ends — 87.7→352pt at
   * the top edge, 52→387.7 at the middle — which is a corner radius of half the
   * height. `radii.pill` is that at any height; a fixed 20 on a 66pt bar is a
   * rectangle with its corners taken off, which is a different object.
   */
  test("it is a pill, and it carries no border", () => {
    const bar = mountBar(toolbar());
    const style = window.getComputedStyle(bar.need("bottom-bar"));

    expect(Number.parseFloat(style.borderTopLeftRadius)).toBeGreaterThanOrEqual(
      layout.bottomBarHeight / 2,
    );
    // The pale edge in the reference is a shadow. A hairline here would be a
    // second way of saying the same thing, and a worse one.
    expect(Number.parseFloat(style.borderTopWidth) || 0).toBe(0);
    expect(style.boxShadow).not.toBe("");
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
    const bar = mountBar([action({ id: "tabs", label: "3 notes open", icon: "file", badge: 3 })]);

    expect(bar.need("bottom-bar-tabs-badge").textContent).toBe("3");
    expect(bar.text()).toContain("3");
  });

  test("zero renders no badge at all, rather than a badge saying 0", () => {
    // "0" in a badge reads as a count worth looking at. Nothing open is nothing
    // to show.
    const bar = mountBar([action({ id: "tabs", label: "No notes open", icon: "file", badge: 0 })]);

    expect(bar.find("bottom-bar-tabs-badge")).toBeNull();
    // The icon is still drawn — what is gone is the badge, not the control.
    expect(bar.need("bottom-bar-tabs").querySelector("[data-icon]")).not.toBeNull();
  });

  test("a count is drawn as the control, not as a badge on one", () => {
    /*
      Obsidian's tab control on mobile is a rounded box with the number of open
      notes inside it and no icon at all. Ours was a document icon with a filled
      accent badge on its corner, which reads as a *notification* — something
      has happened, go and look — rather than as a count of what is already
      open. The number is the whole message, so it is the whole control.
    */
    const bar = mountBar([action({ id: "tabs", label: "3 notes open", icon: "file", count: 3 })]);

    expect(bar.need("bottom-bar-tabs-count").textContent).toBe("3");
    // Not both: an icon behind the box would be the old control with a new
    // decoration in front of it.
    expect(bar.find("bottom-bar-tabs-badge")).toBeNull();
    expect(bar.need("bottom-bar-tabs").textContent).not.toContain("file");
  });

  test("a count still keeps its unsaved marker", () => {
    // We do not autosave and Obsidian does, so the one thing our tab control
    // carries that theirs does not is whether something in there is unsaved.
    const bar = mountBar([
      action({ id: "tabs", label: "3 notes open, 1 unsaved", icon: "file", count: 3, marker: true }),
    ]);
    expect(bar.find("bottom-bar-tabs-count")).not.toBeNull();
    expect(bar.find("bottom-bar-tabs-marker")).not.toBeNull();
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
        icon: "file",
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
  test("a title is drawn under the icon, and hidden from assistive tech", () => {
    // The caption is the exception now rather than the rule — see
    // `BottomBarAction.title`, which records why it used to be nearly
    // mandatory and what removed the reason. It still has to work where it is
    // used, and it is aria-hidden because `label` is already the accessible
    // name: "Search, Search notes" is worse than either alone.
    const bar = mountBar([
      { id: "search", label: "Search notes", title: "Search", icon: "search", onPress: () => {} },
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
      { id: "files", label: "Open the file tree", icon: "panelLeft", onPress: () => {} },
    ]);
    expect(bar.find("bottom-bar-files-title")).toBeNull();
  });
});

/**
 * **The row holds two kinds of thing now, and the rule is what says so.**
 *
 * Six verbs that act on the note in front of somebody, and — in the last
 * position — one destination that leaves it. `BottomBar`'s own header amends
 * "navigation is not its job" and says exactly how far: one key, at the end,
 * behind a separator, and this file does not know what it opens.
 */
describe("the trailing separator", () => {
  /**
   * SABOTAGE: dropped the `action.separated &&` condition so no rule was ever
   * drawn. Fails here and in "it is a hairline".
   */
  test("is drawn before the action that asks for it, and only that one", () => {
    const bar = mountBar(sevenKeys());
    const rules = bar.container.querySelectorAll('[data-testid="bottom-bar-separator"]');
    expect(rules).toHaveLength(1);
  });

  /**
   * The position is the claim, not the count: a rule anywhere but immediately
   * before the seventh key groups the wrong things, and a test that only
   * counted them would pass over that.
   *
   * SABOTAGE: drew the separator *after* the flagged action rather than before
   * it — the off-by-one that reads identically in the source. Fails here.
   */
  test("and it lands between the sixth key and the seventh", () => {
    const bar = mountBar(sevenKeys());
    const row = [...bar.need("bottom-bar").children] as HTMLElement[];
    const ids = row.map((node) => node.dataset.testid);
    expect(ids).toEqual([
      "bottom-bar-back",
      "bottom-bar-forward",
      "bottom-bar-search",
      "bottom-bar-new",
      "bottom-bar-tabs",
      "bottom-bar-menu",
      "bottom-bar-separator",
      "bottom-bar-elsewhere",
    ]);
  });

  test("it is a hairline between two controls, not a seam across the pill", () => {
    const bar = mountBar(sevenKeys());
    const rule = bar.need("bottom-bar-separator");
    expect(px(rule, "width")).toBe(1);
    // Shorter than the bar: a rule the full 66pt of a floating pill reads as
    // the object being split in two rather than as a boundary inside it.
    expect(px(rule, "height")).toBeLessThan(layout.bottomBarHeight);
    // And it does not shrink — a hairline that shrinks is a hairline that
    // disappears on the narrow phone this exists to fit on.
    expect(px(rule, "flex-shrink")).toBe(0);
  });

  test("it says nothing to a screen reader", () => {
    // Every control here is already announced by its own `label`; a decoration
    // between two of them is noise in a list that is the whole of navigating a
    // phone. `aria-hidden`, like the icons and the badges.
    const bar = mountBar(sevenKeys());
    expect(bar.need("bottom-bar-separator").getAttribute("aria-hidden")).toBe("true");
  });

  /**
   * SABOTAGE: removed the `index > 0` guard. Fails here.
   */
  test("a flag on the first action draws no rule against the pill's own edge", () => {
    // A rule in that position is a list somebody reordered, not a boundary
    // anybody meant. The flag is left alone rather than refused: being first is
    // not a disagreement with "my group ends here", it is the same statement
    // with nothing on the other side of it.
    const bar = mountBar([action({ id: "only", separated: true }), action({ id: "second" })]);
    expect(bar.find("bottom-bar-separator")).toBeNull();
    expect(bar.find("bottom-bar-only")).not.toBeNull();
  });

  test("a row that asks for none has none", () => {
    const bar = mountBar(toolbar());
    expect(bar.find("bottom-bar-separator")).toBeNull();
  });

  test("the seventh key is an ordinary action, named by its own label", () => {
    // `BottomBar` exposes the capability and does not name the destination —
    // see its header. What it must still do is treat that key exactly as it
    // treats the six: a real label, a real target, a real press.
    const pressed: string[] = [];
    const bar = mountBar(
      sevenKeys().map((item) =>
        item.id === "elsewhere" ? { ...item, onPress: () => pressed.push(item.id) } : item,
      ),
    );
    const key = bar.need("bottom-bar-elsewhere");
    expect(key.getAttribute("aria-label")).toBe("Go somewhere else");
    bar.click("bottom-bar-elsewhere");
    expect(pressed).toEqual(["elsewhere"]);
  });

  test("and it dims rather than disappearing when it is unavailable", () => {
    // The rule that governs every position on this bar: people aim by
    // position, so an item that vanishes moves every item under a thumb
    // already travelling.
    const bar = mountBar(
      sevenKeys().map((item) => (item.id === "elsewhere" ? { ...item, disabled: true } : item)),
    );
    const key = bar.need("bottom-bar-elsewhere");
    expect(key.getAttribute("aria-disabled")).toBe("true");
    expect(bar.find("bottom-bar-separator")).not.toBeNull();
  });
});
