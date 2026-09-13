/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * The phone's context strip.
 *
 * **A phone has no left panel any more** (`features/app/frame.ts`), so this row
 * and the bottom bar's seventh key are the whole of navigating one. That makes
 * the claims worth testing the same shape as `BottomBar`'s: not "the props
 * arrive" but "somebody can get somewhere" — an order that answers *where am
 * I* without scrolling, a name a screen reader can read, and a strip that does
 * not appear when it would be a control that cannot do anything.
 *
 * ## Two halves, and they are tested in different rooms
 *
 * The **rules** — the order, the ends, whether there is a strip at all — are
 * pure functions in `features/console/strip.ts` and are asserted directly. An ordering is what goes wrong quietly, and a pure function is a
 * rule with a test that runs in milliseconds over every arrangement rather than
 * one arrangement somebody thought of while looking at a screen.
 *
 * The **drawing** is mounted for real, because the things that can be wrong
 * about it are facts about the DOM react-native-web produces: whether a pill
 * shrinks, whether a label reaches assistive tech, whether the menu is inside
 * the scroller that would clip it.
 *
 * ## What this cannot assert
 *
 * jsdom performs no layout. It resolves the injected stylesheet — `flex-shrink`
 * and `min-width` are real assertions — and it cannot tell you that the strip
 * actually leaves the trailing capsule alone on a 390pt screen, or that the
 * fade lands where a half-visible pill is. **The pixels are unverified**: there
 * is no browser in this environment and none of this has been looked at.
 */

// The strip draws no insets of its own; a provider would be a second component
// under test. Non-zero, so a component that leaned on them would show it.
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

const { ContextStrip } =
  require("../features/console/ContextStrip") as typeof import("../features/console/ContextStrip");
const { stripEntries, stripOrder, toneForKind } =
  require("../features/console/strip") as typeof import("../features/console/strip");
const { layout } =
  require("../features/design/tokens") as typeof import("../features/design/tokens");
import type { ConsoleContext } from "../features/console/types";
import type { ConsoleRoute } from "../features/console/nav";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */

const live: Array<() => void> = [];
afterEach(() => {
  while (live.length > 0) live.pop()?.();
  document.body.innerHTML = "";
});

interface Mounted {
  container: HTMLElement;
  find: (testID: string) => HTMLElement | null;
  need: (testID: string) => HTMLElement;
  all: (selector: string) => HTMLElement[];
  press: (testID: string) => void;
  longPress: (testID: string) => void;
  text: () => string;
}

function mount(element: ReactElement, width = 390): Mounted {
  // jsdom reports `clientWidth` as 0 and react-native-web caches it until a
  // `resize` invalidates it, so a mount happens at an explicit stubbed width.
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 844,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => root.render(element));
  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });

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
    all: (selector) => [...container.querySelectorAll<HTMLElement>(selector)],
    text: () => container.textContent ?? "",
    press: (testID) => {
      const node = need(testID);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    /*
      A long press, as react-native-web recognises one: press in, wait past the
      threshold, and release. `Pressable` runs its own timer, so the wait is a
      real one rather than a synthetic event — there is no `longpress` event to
      dispatch.
    */
    longPress: (testID) => {
      const node = need(testID);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      act(() => {
        jest.advanceTimersByTime(600);
      });
      act(() => {
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
    },
  };
}

function styleOf(node: HTMLElement, property: string): string {
  return window.getComputedStyle(node).getPropertyValue(property);
}

function context(over: Partial<ConsoleContext> & { slug: string }): ConsoleContext {
  return {
    id: `id-${over.slug}`,
    displayName: over.slug,
    role: "owner",
    kind: "personal",
    status: "ok",
    ...over,
  };
}

/** A brain of your own, a brain somebody shared, and two workspaces. */
function contexts(): ConsoleContext[] {
  return [
    context({ slug: "seyi" }),
    context({ slug: "sayo", role: "member" }),
    context({ slug: "acme", kind: "shared", role: "editor" }),
    context({ slug: "supa", kind: "shared", role: "owner" }),
  ];
}

const NO_ENDS = { claim: false, create: false };

function mountStrip(over: Partial<Parameters<typeof ContextStrip>[0]> = {}): Mounted {
  return mount(
    createElement(ContextStrip, {
      contexts: contexts(),
      currentSlug: "seyi",
      recent: [],
      loading: false,
      onOpen: () => {},
      onSelect: () => {},
      ...over,
    }),
  );
}

/* -------------------------------------------------------------------------- */
/*                                 the rules                                  */
/* -------------------------------------------------------------------------- */

describe("the strip is where you can go, not where you are", () => {
  /**
   * The context you are in is NOT on this row. It is the button at the head of
   * the breadcrumb (`CurrentContextPill`), which is the way to its root — so
   * this row is the contexts you can switch *to*, and every pill on it goes
   * somewhere you are not.
   *
   * It was pinned first and lit here, with the path line naming the same
   * context again one row down. Deleting the *path* half was the first fix and
   * the wrong one: it took the way up with it, and a top-level folder was left
   * with no route to its own root.
   *
   * SABOTAGE: dropped the `!== currentSlug` filter from `stripOrder`. Fails
   * here and in "the strip draws no pill for the context you are in" — the two
   * halves of the same claim, in the two rooms.
   */
  test("the context you are in is not on the strip at all", () => {
    const order = stripOrder(contexts(), "acme", [{ slug: "supa" }, { slug: "seyi" }]);
    expect(order.map((entry) => entry.slug)).toEqual(["supa", "seyi", "sayo"]);
    expect(order.map((entry) => entry.slug)).not.toContain("acme");
  });

  /**
   * SABOTAGE: sorted by `slug.localeCompare` instead of by rank. Fails here —
   * and the fixture is chosen so that it *would* pass an alphabetical
   * implementation if the recency were ignored, which is why the expectation
   * below is not in alphabetical order.
   */
  test("and they are most recently visited, never alphabetical", () => {
    const order = stripOrder(contexts(), "seyi", [
      { slug: "seyi" },
      { slug: "supa" },
      { slug: "sayo" },
      { slug: "acme" },
    ]);
    expect(order.map((entry) => entry.slug)).toEqual(["supa", "sayo", "acme"]);
    // The alphabetical answer, spelled out, so a reader can see the two differ.
    expect(order.map((entry) => entry.slug)).not.toEqual(["acme", "sayo", "supa"]);
  });

  /**
   * SABOTAGE: gave an unvisited context rank `-1` instead of putting it last.
   * Fails here only.
   */
  test("a context this device has never seen sorts after every one it has", () => {
    const order = stripOrder(contexts(), null, [{ slug: "supa" }]);
    expect(order.map((entry) => entry.slug)).toEqual(["supa", "seyi", "sayo", "acme"]);
  });

  test("with nothing remembered it is the control plane's own order", () => {
    // The first paint, before the device has answered. A strip that waited for
    // the store would be empty for a tick on the surface that is the whole of
    // navigation; this is the same list, unordered by recency.
    const order = stripOrder(contexts(), null, []);
    expect(order.map((entry) => entry.slug)).toEqual(["seyi", "sayo", "acme", "supa"]);
  });

  test("a log naming contexts that are gone does not drop or reorder the rest", () => {
    // Somebody removed from `@acme` still has an entry for it on this device.
    const order = stripOrder(contexts(), "seyi", [
      { slug: "removed-long-ago" },
      { slug: "supa" },
    ]);
    expect(order.map((entry) => entry.slug)).toEqual(["supa", "sayo", "acme"]);
  });

  test("every context the viewer can reach but the one they are in", () => {
    // Brains and workspaces undivided — the rail's two headed groups are one
    // row here, and the kind is the dot.
    const order = stripOrder(contexts(), "seyi", []);
    expect(order).toHaveLength(contexts().length - 1);
    expect(new Set(order.map((entry) => entry.slug))).toEqual(
      new Set(["sayo", "acme", "supa"]),
    );
  });

  test("...and all of them when the viewer is in none", () => {
    // The app-level panes: Map, Connections, Settings with no context open.
    // Nothing is being excluded, so nothing is missing.
    const order = stripOrder(contexts(), null, []);
    expect(order).toHaveLength(contexts().length);
  });
});

describe("the kind is a colour, and it is not an alarm", () => {
  /**
   * SABOTAGE: `toneForKind` reading `role` instead of `kind` — the tempting
   * near-miss, since a brain is a context you own. Fails here on `@supa`, a
   * workspace the viewer owns, and on `@sayo`, a brain they do not.
   */
  test("a brain and a workspace are told apart without a heading", () => {
    expect(toneForKind(context({ slug: "seyi", kind: "personal" }))).toBe("ok");
    expect(toneForKind(context({ slug: "sayo", kind: "personal", role: "member" }))).toBe("ok");
    expect(toneForKind(context({ slug: "acme", kind: "shared" }))).toBe("neutral");
    expect(toneForKind(context({ slug: "supa", kind: "shared", role: "owner" }))).toBe("neutral");
  });

  test("neither kind is drawn in a status colour", () => {
    // `warn` and `crit` are what the rail's pip uses for a bucket in trouble. A
    // *kind* in one of them is a permanent alert about nothing — and the strip
    // deliberately carries no status at all, so a reader never has to work out
    // which of the two meanings a pip has.
    for (const kind of ["personal", "shared"]) {
      const tone = toneForKind(context({ slug: "x", kind, status: "crit" }));
      expect(["warn", "crit"]).not.toContain(tone);
    }
  });
});

describe("an empty row is not drawn", () => {
  /**
   * SABOTAGE: `total > 0` → `total >= 0`. Fails here only.
   */
  test("one context and nothing to reach is no strip at all", () => {
    /*
      The only context is the one you are in, which `stripOrder` drops, so
      there is nothing to switch to — and the name is on the screen anyway, at
      the head of the breadcrumb. The band goes back to the note.
    */
    expect(stripEntries([context({ slug: "seyi" })], "seyi", [], NO_ENDS)).toBeNull();
    expect(stripEntries([], null, [], NO_ENDS)).toBeNull();
  });

  /**
   * The reading this takes of "nothing to switch to → no strip", and it is the
   * rule's own stated reason rather than a departure from it: *an empty row is
   * chrome that does nothing*. A row holding "New workspace" is not empty, and
   * `rail.ts` records that this entry is "the *whole* group for somebody who is
   * in no workspaces yet, which is how a person who has only ever had a brain
   * finds out that workspaces exist". Counting contexts rather than entries
   * would take that away from exactly the person it was written for — one
   * brain, a phone, and no other surface offering it, since the rail is not on
   * a phone any more.
   *
   * SABOTAGE: counted `ordered.length` instead of the total. Fails here and in
   * the render case below.
   */
  test("but one context and somewhere to go is a strip of the somewhere", () => {
    const entries = stripEntries([context({ slug: "seyi" })], "seyi", [], {
      claim: false,
      create: true,
    });
    // No pills — the only context is the current one — and the row exists for
    // the entry at the end of it.
    expect(entries).toEqual([]);
  });

  test("and no contexts at all with a claim to offer is still a strip", () => {
    // Somebody who arrived through an invitation and is in nothing yet.
    expect(stripEntries([], null, [], { claim: true, create: true })).toEqual([]);
  });

  test("two contexts is a strip of the one you are not in", () => {
    const two = [context({ slug: "seyi" }), context({ slug: "supa", kind: "shared" })];
    expect(stripEntries(two, "seyi", [], NO_ENDS)?.map((entry) => entry.slug)).toEqual(["supa"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the drawing                                */
/* -------------------------------------------------------------------------- */

describe("what is on the strip", () => {
  test("a pill per context, in the order the rules decided", () => {
    const strip = mountStrip({ recent: [{ slug: "supa" }] });
    // `@seyi` is the current context: it is in the breadcrumb, not here.
    for (const slug of ["sayo", "acme", "supa"]) {
      expect(strip.find(`context-strip-${slug}`)).not.toBeNull();
    }
    // Document order is the strip's order.
    const drawn = strip
      .all("[data-testid^='context-strip-']")
      .map((node) => node.dataset.testid)
      .filter((id) => id !== undefined && !id.endsWith("-scroll") && !id.endsWith("-fade"))
      .map((id) => id!.replace("context-strip-", ""));
    // `@seyi` is the current context and is drawn in the breadcrumb instead.
    expect(drawn).toEqual(["supa", "sayo", "acme"]);
  });

  /**
   * SABOTAGE: replaced each pill's `accessibilityLabel` with `undefined`, so
   * the name would be derived from the content the way the rail's collapsed
   * mode once tried to. Fails here — and it is the rule that killed that
   * collapse, so it is asserted rather than trusted.
   */
  test("every pill carries a real name, and every one is somewhere to go", () => {
    const strip = mountStrip();
    expect(strip.need("context-strip-supa").getAttribute("aria-label")).toBe("Open @supa");
    expect(strip.need("context-strip-sayo").getAttribute("aria-label")).toBe("Open @sayo");
    // And the dot beside it says nothing to a reader, which is why the label
    // has to carry the whole message.
    for (const node of strip.all("[data-testid^='context-strip-']")) {
      const label = node.getAttribute("aria-label");
      if (node.getAttribute("role") !== "button") continue;
      expect(label).toBeTruthy();
      expect(label).not.toBe("");
    }
  });

  /**
   * The rendered half of "the strip is where you can go, not where you are".
   *
   * There is no lit pill here any more, because there is no pill for the
   * current context at all — it is `CurrentContextPill`, in the breadcrumb, and
   * `navBand.test.ts` holds that end.
   *
   * SABOTAGE: dropped the `!== currentSlug` filter from `stripOrder`. Fails
   * here and in "the context you are in is not on the strip at all".
   */
  test("the strip draws no pill for the context you are in", () => {
    const strip = mountStrip({ currentSlug: "acme", recent: [{ slug: "supa" }] });
    expect(strip.find("context-strip-acme")).toBeNull();
    // And the first pill is the most recently visited of the rest, not a
    // pinned label.
    const first = strip.all("[role='button']")[0]!;
    expect(first.dataset.testid).toBe("context-strip-supa");
    // Nothing on this row is "selected": every pill goes somewhere you are not.
    for (const node of strip.all("[data-testid^='context-strip-']")) {
      expect(node.getAttribute("aria-selected")).toBeNull();
    }
  });

  test("pressing a pill asks the layout to open it, by slug", () => {
    const opened: string[] = [];
    const strip = mountStrip({ onOpen: (slug) => opened.push(slug) });
    strip.press("context-strip-supa");
    expect(opened).toEqual(["supa"]);
  });

  /**
   * The strip is a landmark, because a phone has no other navigation to be one.
   *
   * `AppFrame` declares `role="navigation"` on the rail column and on the rail
   * sheet, and **neither renders at compact**. This strip and `BottomBar` were
   * the two surfaces navigation moved to and neither declared anything, so a
   * phone-width browser window had zero navigation landmarks — the console's
   * whole navigation unreachable to a screen reader rotoring by landmark, or to
   * anything that jumps to `<nav>`. The pills' own `aria-label`s make each
   * *control* usable; they are not the same capability as finding the group.
   *
   * react-native-web maps `role="navigation"` to a real `<nav>`, so this is the
   * element itself rather than an attribute on a `div`.
   *
   * SABOTAGE: dropped `role` and `aria-label` from the strip's root. Fails here
   * and in `consoleChrome.test.ts`'s `a phone has a navigation landmark, and it
   * is not the toolbar` — the two halves of the claim, in the two rooms.
   */
  test("it is a navigation landmark, and it says which navigation", () => {
    const strip = mountStrip();
    const band = strip.need("context-strip");
    expect(band.tagName.toLowerCase()).toBe("nav");
    expect(band.getAttribute("aria-label")).toBe("Contexts");
  });

  /**
   * A pill is a target a thumb has to hit, and it is the only one for this.
   *
   * **This strip is the phone's primary navigation.** A phone has no rail and
   * no file-tree drawer (`features/app/frame.ts`), so a pill is the whole of
   * moving between contexts — there is no menu, no keymap and no second control
   * anywhere that reaches the same place. A target under the floor here is not
   * a nuisance; it is navigation somebody misses and concludes is broken.
   *
   * The other two surfaces on the same glass each kept this guard when the nav
   * toggle's was deleted with the toggle: `consoleChrome.test.ts` holds the
   * pinned account slot (`sign-out is reachable, and is a target a thumb can
   * hit`) and `bottomBar.test.ts` holds the bottom row. The strip had none, so
   * `layout.chromeButton` — the height every pill takes — had **zero** hits
   * anywhere in `__tests__`.
   *
   * Asserted against `layout.minTouchTarget` and not against `chromeButton`:
   * reading the same token the style reads would pass for whatever value it
   * happens to hold, which is exactly the mutant below.
   *
   * SABOTAGE: `chromeButton: 36` in `tokens.ts` — the tidy-looking "make the
   * top row less chunky" edit. MEASURED against a green 172 suites / 3,285: it
   * fails here, and it fails one other test that is **not** a guard on this —
   * `safeArea.test.ts`'s `a document pane clears the notch and the floating
   * toggle`, which recomputes the note's top padding against a literal `44` for
   * the *frame's* chrome band. That one catches the token moving; it says
   * nothing about whether a pill is a target, it would pass for a 36pt pill
   * under a 44pt band, and it is in a different file about a different surface.
   * The strip's own claim had no test at all before this one.
   */
  test("a pill clears the touch floor, because it is how a phone changes context", () => {
    const strip = mountStrip();
    for (const testID of ["context-strip-sayo", "context-strip-supa"]) {
      const height = Number.parseFloat(styleOf(strip.need(testID), "height"));
      expect(height).toBeGreaterThanOrEqual(layout.minTouchTarget);
    }
  });

  test("and clears it sideways too, which is the axis the mark actually shrank on", () => {
    /*
      The target's own docblock said `minTouchTarget` "on both axes with the
      mark centred inside it" over a rule that set `height` and nothing else.
      The claim was harmless while the pill was a stadium and stopped being
      harmless in the change that made it "smaller and squarer" — the horizontal
      saving is where that was actually paid, so a short slug's target came out
      about 31pt wide on the phone's only context switcher.

      `minWidth`, not `width`: a long slug's pill is wider than the floor and
      should stay that way.
    */
    const strip = mountStrip();
    for (const testID of ["context-strip-sayo", "context-strip-supa"]) {
      // `min-width` rather than `width`: a long slug's pill is legitimately
      // wider than the floor, so what is being held is the floor itself.
      const floor = Number.parseFloat(styleOf(strip.need(testID), "min-width"));
      expect(`${testID}: ${floor >= layout.minTouchTarget}`).toBe(`${testID}: true`);
    }
  });

  /**
   * ...and the *mark* is smaller than the target, which is how more of them fit.
   *
   * From the owner's review of a real recording: the pills "should be smaller
   * and squarer" so more workspaces are on screen at once. The obvious edit is
   * to shrink the pill, and the test above is what stands in front of it: this
   * strip is a phone's *only* way between contexts, so a target under the floor
   * is navigation somebody misses and concludes is broken.
   *
   * So the two are separated, which is `accountAvatar`'s own rule finally
   * applied here — "what a thumb hits is the pressable around it". The
   * pressable stays `minTouchTarget` and draws nothing; the pill inside it is
   * the object, shorter and on a corner radius rather than a stadium's. Reading
   * it back off the mounted DOM rather than off the token, so a token edit that
   * collapses the two into one again fails here.
   *
   * SABOTAGE: drew the visible pill at the target's own height again.
   * MEASURED: this test failed, the floor test above stayed green — which is
   * the pair working: one holds the thumb, the other holds the eye.
   */
  test("a pill's mark is smaller than the thumb that presses it, and squarer", () => {
    const strip = mountStrip();
    const target = strip.need("context-strip-sayo");
    const mark = target.querySelector<HTMLElement>('[data-testid="mark-context-strip-sayo"]');
    expect(mark).not.toBeNull();

    const targetHeight = Number.parseFloat(styleOf(target, "height"));
    const markHeight = Number.parseFloat(styleOf(mark!, "height"));
    expect(markHeight).toBeLessThan(targetHeight);
    expect(targetHeight).toBeGreaterThanOrEqual(layout.minTouchTarget);

    /*
      Squarer: a radius under half the height is a rounded rectangle, and a
      radius at or over it is the stadium this replaces. Stated as the geometric
      property rather than as the number, because the number is the thing that
      is allowed to be tuned.
    */
    const radius = Number.parseFloat(styleOf(mark!, "border-top-left-radius"));
    expect(radius).toBeLessThan(markHeight / 2);
  });

  /**
   * SABOTAGE: gave the pill `flexShrink: 1` and `numberOfLines={1}` — the two
   * halves of the tidy-looking fix for a long name. Fails here.
   */
  test("a pill is as wide as its name, and never truncates", () => {
    const strip = mountStrip({
      contexts: [
        context({ slug: "seyi" }),
        context({ slug: "acme-engineering-platform", kind: "shared" }),
      ],
    });
    const long = strip.need("context-strip-acme-engineering-platform");
    expect(styleOf(long, "flex-shrink")).toBe("0");
    // The whole name is in the tree — an ellipsis would be two contexts that
    // look identical on the control whose job is telling them apart.
    expect(strip.text()).toContain("@acme-engineering-platform");
    for (const node of strip.all("[data-testid^='context-strip-'] div")) {
      expect(styleOf(node, "text-overflow")).not.toBe("ellipsis");
    }
  });

  /**
   * The row never wraps, and it never grows a second one.
   *
   * **This asserted `flex: 1` and that is now the wrong rule.** The strip was
   * the flexible middle of the frame's top row, taking what the pinned account
   * mark and the trailing capsule left; it is the first row of `NavBand` now,
   * inside the scroller, where the only thing along its axis is the width of
   * the surface. `flex: 1` there is a child of a *column* asking for the
   * remaining height of a container that has none — a row that collapses to
   * nothing — so the width rule is `align-self: stretch` and the height is the
   * pills'.
   *
   * (An earlier version asserted `min-width: 0` and was vacuous:
   * react-native-web puts it in the base style of every `View`, so it resolved
   * whether the declaration was there or not. Measured by deleting it and
   * watching this pass.)
   *
   * SABOTAGE: `alignSelf: "stretch"` → `alignSelf: "flex-start"` on `strip`
   * (the shape that stops the row using the width it has). Fails here.
   */
  test("the row never wraps, and the strip takes the width it is given", () => {
    const strip = mountStrip();
    expect(styleOf(strip.need("context-strip-scroll"), "flex-direction")).not.toBe("column");
    const band = strip.need("context-strip");
    expect(styleOf(band, "align-self")).toBe("stretch");
    // Not the flexible middle of a row any more: growing here would be asking
    // a column for height it does not have.
    expect(styleOf(band, "flex-grow")).not.toBe("1");
    // The pills are what refuse to shrink; the scroller absorbs the overflow.
    expect(styleOf(strip.need("context-strip-sayo"), "flex-shrink")).toBe("0");
  });

  /**
   * The falloff, asserted as far as jsdom can see it.
   *
   * react-native-web compiles the declaration to an atomic class
   * (`r-backgroundImage-…`) and injects the rule through the CSSOM, and jsdom's
   * `cssstyle` drops `background-image: linear-gradient(…)` as a value it
   * cannot parse — so `getComputedStyle` answers `""` whether the fade is there
   * or not, which would make the obvious assertion vacuous. The class is what
   * is actually observable, and it is only emitted for a declaration that was
   * made. **Whether the gradient looks right is unverified**; there is no
   * browser here.
   *
   * SABOTAGE: removed the `gradient(...)` spread from the `fade` style. The
   * class disappears and this fails.
   */
  test("and it fades at the trailing edge rather than cutting a pill in half", () => {
    const strip = mountStrip();
    const fade = strip.need("context-strip-fade");
    expect(fade.className).toContain("r-backgroundImage");
    // It lies over the last pill, so a press must pass through it.
    expect(styleOf(fade, "pointer-events")).toBe("none");
  });
});

describe("the ends of the list", () => {
  test("New workspace is there, quietly, and it is a real target", () => {
    const created: number[] = [];
    const strip = mountStrip({ onCreateWorkspace: () => created.push(1) });
    const create = strip.need("context-strip-create");
    expect(create.getAttribute("aria-label")).toBe("Create a new shared workspace");
    strip.press("context-strip-create");
    expect(created).toEqual([1]);
  });

  /**
   * SABOTAGE: dropped the `offerOwnContext` call and offered the claim
   * whenever the callback was present. Fails here — the viewer in this fixture
   * owns `@seyi`, so the entry must be absent.
   */
  test("Claim your @name only for somebody who has no brain of their own", () => {
    const withOwn = mountStrip({ onClaimContext: () => {} });
    expect(withOwn.find("context-strip-claim")).toBeNull();

    const invitee = mountStrip({
      contexts: [context({ slug: "acme", kind: "shared", role: "member" })],
      currentSlug: "acme",
      onClaimContext: () => {},
    });
    expect(invitee.need("context-strip-claim").getAttribute("aria-label")).toBe(
      "Claim your name and create your own workspace",
    );
  });

  /**
   * The two entries are drawn differently on purpose, and it is the same
   * decision the rail records rather than a new one: the claim is a *gap in the
   * list*, for somebody with no reason to suspect the product does anything
   * else, so it is accented and it stops existing the moment it is used. "New
   * workspace" is a permanent verb, so an accent on it would be an
   * advertisement on every screen of every session.
   *
   * SABOTAGE: accented both. Fails here.
   */
  test("the claim is accented and the create is not", () => {
    const strip = mountStrip({
      contexts: [context({ slug: "acme", kind: "shared", role: "member" })],
      currentSlug: "acme",
      onClaimContext: () => {},
      onCreateWorkspace: () => {},
    });
    /*
      Read off the **mark**, which is where the fill now is: the pressable is
      the target and draws nothing (see `a pill's mark is smaller than the thumb
      that presses it`). Same assertion, on the element that actually paints —
      and the `not.toBe` still catches two transparent backgrounds, because it
      would then be comparing one colour to itself.
    */
    const claim = styleOf(strip.need("mark-context-strip-claim"), "background-color");
    const create = styleOf(strip.need("mark-context-strip-create"), "background-color");
    expect(claim).not.toBe(create);
    expect(claim).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("nothing is offered where there is nowhere to send anybody", () => {
    // The landing page's picture of the console, and the read-only demo.
    const strip = mountStrip();
    expect(strip.find("context-strip-claim")).toBeNull();
    expect(strip.find("context-strip-create")).toBeNull();
  });

  test("one context and New workspace still draws a strip", () => {
    const strip = mountStrip({
      contexts: [context({ slug: "seyi" })],
      onCreateWorkspace: () => {},
    });
    expect(strip.find("context-strip")).not.toBeNull();
    expect(strip.find("context-strip-create")).not.toBeNull();
  });

  test("and one context with nothing offered draws none", () => {
    const strip = mountStrip({ contexts: [context({ slug: "seyi" })] });
    expect(strip.find("context-strip")).toBeNull();
  });
});

describe("a long press opens the context's own menu", () => {
  test("the existing one, with its own items", () => {
    jest.useFakeTimers();
    try {
      const strip = mountStrip();
      expect(strip.find("context-menu")).toBeNull();
      strip.longPress("context-strip-supa");
      expect(strip.find("context-menu")).not.toBeNull();
      // Reused rather than reimplemented: these are `contextMenuItems`' own
      // keys, so a second menu with a different list would fail here.
      expect(strip.find("context-menu-settings")).not.toBeNull();
      expect(strip.find("context-menu-sharing")).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * SABOTAGE: rendered the menu inside the `ScrollView` instead of beside it —
   * the placement that looks right, and the one a horizontal scroller clips
   * away to nothing on the web. Fails here.
   */
  test("and it is not inside the scroller that would clip it", () => {
    jest.useFakeTimers();
    try {
      const strip = mountStrip();
      strip.longPress("context-strip-supa");
      const menu = strip.need("context-menu");
      const scroller = strip.need("context-strip-scroll");
      expect(scroller.contains(menu)).toBe(false);
      expect(strip.need("context-strip").contains(menu)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test("Leave is offered on a context you do not own, and not on one you do", () => {
    jest.useFakeTimers();
    try {
      // The role, not the row's position — every workspace here is "shared"
      // and `@supa` is one the viewer owns.
      const mine = mountStrip();
      mine.longPress("context-strip-supa");
      expect(mine.find("context-menu-leave")).toBeNull();

      const theirs = mountStrip();
      theirs.longPress("context-strip-acme");
      expect(theirs.find("context-menu-leave")).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("choosing a destination closes the menu and reports it once", () => {
    jest.useFakeTimers();
    try {
      const chosen: ConsoleRoute[] = [];
      const strip = mountStrip({ onSelect: (route) => chosen.push(route) });
      strip.longPress("context-strip-supa");
      strip.press("context-menu-settings");
      expect(chosen).toEqual([{ kind: "context", slug: "supa", view: "settings" }]);
      expect(strip.find("context-menu")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a plain press opens the context rather than the menu", () => {
    jest.useFakeTimers();
    try {
      const opened: string[] = [];
      const strip = mountStrip({ onOpen: (slug) => opened.push(slug) });
      strip.press("context-strip-supa");
      expect(opened).toEqual(["supa"]);
      expect(strip.find("context-menu")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
