/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

// React only treats `act` as authoritative when this is set, and warns on every
// call when it is not — which buries a real un-acted-update warning in noise.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The application frame, mounted for real.
 *
 * `appFrame.test.ts` pins the *rules* — which regions exist at which width —
 * as pure functions. This file checks that the component actually obeys them
 * once react-native-web has turned them into DOM, which is a different claim
 * and the one that has historically been wrong: the console's previous shell
 * looked correct in source and still put the app inside a page that scrolled.
 *
 * ## What this can and cannot assert
 *
 * jsdom lays nothing out, so this is a **render test, not a layout test**. It
 * can resolve react-native-web's injected stylesheet, so "the frame is one
 * viewport tall and clips" and "there is a bottom toolbar and no rail" are real
 * assertions. It cannot tell you the drawer is 86% wide or that the editor's
 * measure is comfortable; those were checked in a browser at 390×844, 768×1024
 * and 1440×900, and on the device sizes in the pull request.
 *
 * Every assertion here has been verified to fail with the corresponding rule
 * reverted — see the sabotage runs recorded in the pull request.
 */

// `mock`-prefixed so `jest.mock`'s hoisted factory may close over it.
const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };

// The frame reads the notch and the home indicator. A provider would be a
// second thing under test; the insets themselves are the platform's business,
// not this component's.
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

// Imported after the mock, which `jest.mock` hoists above it anyway.
const { AppFrame, useFrame } =
  require("../features/app/AppFrame") as typeof import("../features/app/AppFrame");
const { layout } = require("../features/design/tokens") as typeof import("../features/design/tokens");
const { bottomChromeHeight } =
  require("../features/app/bottomChrome") as typeof import("../features/app/bottomChrome");
const { viewportHeight } = require("../features/design/css") as typeof import("../features/design/css");

/* -------------------------------------------------------------------------- */

interface Mounted {
  container: HTMLElement;
  press: (testId: string) => void;
  find: (testId: string) => HTMLElement | null;
  text: () => string;
  /** Change the window width on a mounted frame — a rotation, or a drag. */
  resize: (width: number) => void;
  unmount: () => void;
}

/**
 * @param options.explorer  Pass `false` for a route with no file tree — Map and
 *   Connections, which is where signing in lands you. Every test here used to
 *   mount *with* a tree, so the pane the whole fix exists for was never once
 *   rendered and a regression gated on `explorer != null` walked straight
 *   through the suite.
 */
function mountFrame(
  width: number,
  children: ReactNode = "the note",
  options: { explorer?: boolean; accountSlot?: boolean } = {},
): Mounted {
  // Widening the window in jsdom takes more than it looks like it should, and
  // getting it wrong is silent rather than loud.
  //
  // `useWindowDimensions` does not read `window.innerWidth`. react-native-web's
  // `Dimensions` measures `document.documentElement.clientWidth`, caches it, and
  // refreshes on the window's `resize` event. **jsdom reports that as 0** — it
  // performs no layout — so an unstubbed mount reports a width of zero, lands
  // in the compact branch, and every phone assertion passes for entirely the
  // wrong reason while every desktop assertion fails. Stub the element, then
  // dispatch the resize that invalidates the cache.
  const applyWidth = (next: number) => {
    Object.defineProperty(document.documentElement, "clientWidth", {
      value: next,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      value: 800,
      configurable: true,
    });
    Object.defineProperty(window, "innerWidth", { value: next, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    window.dispatchEvent(new Event("resize"));
  };
  applyWidth(width);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  act(() => {
    root.render(
      createElement(AppFrame, {
        switcher: createElement("span", { "data-testid": "switcher" }, "@seyi"),
        /*
          The phone's leading slot, as a stub. `AppFrame` "knows about geometry
          and nothing else", so what a test needs from it is that it is laid out
          in the right place and drawn at the right densities — what it contains
          is `Account`'s business.
        */
        accountSlot:
          options.accountSlot === false
            ? undefined
            : createElement("span", { "data-testid": "account" }, "you"),
        // The trailing capsule, at the other end of the same row.
        topTrailing: createElement("span", { "data-testid": "trailing" }, "actions"),
        /*
          The open notes, passed **unconditionally and at every width**, which
          is the point. `_layout.tsx` guards with `!phone` and the frame is
          asked to hold the same line on its own — see the case below.
        */
        tabs: createElement("span", { "data-testid": "tabs" }, "notes"),
        explorer:
          options.explorer === false
            ? undefined
            : createElement("span", { "data-testid": "explorer" }, "tree"),
        status: createElement("span", { "data-testid": "status" }, "490 words"),
        bottomBar: createElement("span", { "data-testid": "bottom" }, "toolbar"),
        onSearch: () => {},
        children,
      }),
    );
  });

  const find = (testId: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  return {
    container,
    find,
    text: () => container.textContent ?? "",
    resize: (next: number) => {
      act(() => applyWidth(next));
    },
    press: (testId: string) => {
      const node = find(testId);
      if (node === null) throw new Error(`no element with testID ${testId}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** The resolved value react-native-web actually gave this node. */
function styleOf(node: HTMLElement, property: string): string {
  return window.getComputedStyle(node).getPropertyValue(property);
}

/**
 * ⌘B and ⌘⇧E, reached through the frame's own API.
 *
 * Module level because two describes need it. There is no control in the chrome
 * that reaches either command on a phone any more — that was the point of the
 * toggles — so a probe is the only way to press them at that density, and
 * pressing them is exactly what has to be proven harmless.
 */
function TogglesProbe() {
  const frame = useFrame();
  /*
    One button, and it used to be two.

    `frame.toggleRail` was the other, and it went with the rail: there is no
    column at any density now, so a probe for it would be a press with nothing
    to observe. What is left is the tree's, which is the command this file
    still has to prove harmless at compact.
  */
  return createElement(
    "button",
    { "data-testid": "probe-toggle-explorer", onClick: frame.toggleExplorer },
    "toggle the explorer",
  );
}

/** Hover in and out of a node, which is how react-native-web reports `onHoverIn`. */
function hover(node: HTMLElement) {
  return {
    in: () =>
      act(() => {
        node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      }),
    out: () =>
      act(() => {
        node.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
      }),
  };
}

/** ⌘\\, the same way `console/_layout.tsx` reaches it. */
function FocusProbe() {
  const frame = useFrame();
  return createElement(
    "button",
    { "data-testid": "probe-toggle-focus", onClick: frame.toggleFocus },
    "toggle focus",
  );
}

/* -------------------------------------------------------------------------- */

describe("the frame owns the viewport", () => {
  test("it is one dynamic viewport tall, never 100vh", () => {
    // Asserted against `viewportHeight()` rather than the rendered node,
    // because jsdom's CSS parser does not know `dvh` and silently drops the
    // whole declaration — `getComputedStyle(frame).height` comes back as `""`
    // whichever unit is used, so a render assertion here would pass just as
    // happily with the broken unit in place.
    //
    // The unit is the thing worth guarding. On a phone browser `100vh` is
    // measured against the viewport with the URL bar *hidden*, so a `100vh`
    // frame is 60–100px taller than the screen and its bottom toolbar sits
    // underneath the browser chrome, permanently out of reach. `dvh` tracks the
    // bar as it collapses. This is invisible on a desktop, which is exactly why
    // it needs a test rather than a look.
    expect(viewportHeight()).toMatchObject({ height: "100dvh", maxHeight: "100dvh" });
  });

  test("the frame clips rather than growing past the screen", () => {
    const app = mountFrame(1440);
    const frame = app.find("app-frame")!;

    expect(frame).not.toBeNull();
    // react-native-web expands the `overflow` shorthand into its two axes,
    // and jsdom only resolves the longhands — the shorthand comes back "".
    expect(styleOf(frame, "overflow-y")).toBe("hidden");
    expect(styleOf(frame, "overflow-x")).toBe("hidden");

    app.unmount();
  });

  test("no ancestor of the frame scrolls", () => {
    // The whole point of the rebuild: the console used to be a card inside the
    // landing page's ScrollView, so the page scrolled and the tree scrolled
    // again inside a fixed 432px box.
    const app = mountFrame(1440);
    let node: HTMLElement | null = app.find("app-frame");
    while (node !== null && node !== document.body) {
      const overflow = styleOf(node, "overflow-y");
      expect(["auto", "scroll"]).not.toContain(overflow);
      node = node.parentElement;
    }
    app.unmount();
  });
});

describe("a phone", () => {
  /**
   * The toolbar's gap from the bottom of the glass, which is one number and not
   * two added together.
   *
   * `BottomBar` is a floating pill and needs a gap under it; a notched phone's
   * home indicator inset already *is* a gap. Summing them is the "bar floating
   * 68px above the home indicator" that file warns about, and because the frame
   * is `100dvh` and clips, the overflow comes out of the editor rather than
   * growing the frame. So the frame takes whichever is larger — and `BottomBar`
   * itself sets nothing on that edge, which the toolbar's own suite asserts
   * separately.
   *
   * Driven from both sides: a browser with no inset must still get a gap, and a
   * notched phone must not get one on top of its inset.
   *
   * The floor is `floatingGap` (25), measured off Obsidian — its bar ends about
   * 25pt above the bottom of the glass. It used to be `floatingInset` (10),
   * which is near enough to the edge that the pill read as attached to it.
   */
  test("the toolbar's bottom gap is the larger of the inset and the float, never both", () => {
    mockInsets.bottom = 0;
    let app = mountFrame(390);
    let band = app.find("bottom")!.parentElement!;
    expect(Number.parseFloat(styleOf(band, "padding-bottom"))).toBe(layout.floatingGap);
    app.unmount();

    mockInsets.bottom = 34;
    app = mountFrame(390);
    band = app.find("bottom")!.parentElement!;
    expect(Number.parseFloat(styleOf(band, "padding-bottom"))).toBe(34);
    app.unmount();

    // Left as the suite found it: `mockInsets` is module-level and shared.
    mockInsets.bottom = 0;
  });

  /**
   * And its gap from the *side* edges, which is the frame's too.
   *
   * The pill used to be sized by its own contents and centred, so the inset
   * either side was whatever was left over — a number that changes with how
   * many actions the current route offers. A device measured it at 78pt on a
   * context the reader is only a member of, where there is no New note.
   *
   * So the slot carries the inset and the bar fills it, and that is why this is
   * asserted here rather than in `bottomBar.test.ts`: the toolbar cannot know
   * how wide the glass is, and the number was never its to hold.
   *
   * **The arithmetic that used to sit under this is gone from here on purpose.**
   * It read `440 − 2 × inset === 336`, pinning the reference's own pill width —
   * and the inset is 24 now rather than 52, because the sliver of note it
   * bought is what paid for the bottom row's seventh key. The reason to move it
   * rather than update it is that it is a claim about *how many targets fit*,
   * which is the toolbar's, and `bottomBar.test.ts` now computes both rows from
   * the tokens. What belongs here is only that the frame is the one spending
   * the number.
   */
  test("the toolbar is inset from the side edges by the frame, not by its contents", () => {
    const app = mountFrame(440);
    const band = app.find("bottom")!.parentElement!;

    expect(Number.parseFloat(styleOf(band, "padding-left"))).toBe(layout.bottomBarInset);
    expect(Number.parseFloat(styleOf(band, "padding-right"))).toBe(layout.bottomBarInset);
    app.unmount();
  });

  test("is the editor and a bottom toolbar, with no rail", () => {
    const app = mountFrame(390);

    expect(app.text()).toContain("the note");
    expect(app.find("bottom")).not.toBeNull();
    expect(app.find("status")).toBeNull();
    expect(app.find("rail-full")).toBeNull();
    expect(app.find("rail-icons")).toBeNull();
    // The tree is not merely off-screen — it is not mounted, so it costs
    // nothing. It used to be "until it is asked for"; nothing asks now.
    expect(app.find("explorer")).toBeNull();

    app.unmount();
  });

  /* ------------------------------------------------------------------ *
   * No left panel, at either route.
   *
   * A block of tests replaces a longer one, and what it replaced is worth
   * naming: a drawer the toggle brought in, a rail sheet the switcher brought
   * in, one scrim they shared, a chevron that turned over, and the rule that
   * raising one put the other away. All of it worked. What it cost was that
   * every switch of context was a press to open a panel, a press to choose,
   * and a scrim over the note in between — and the panel was also the only
   * route to the app's other places, so one control carried two jobs.
   *
   * `features/app/frame.ts` has the argument. These are the assertions that
   * none of it is drawn any more, which is a different claim from "the flags
   * are false" and is the one a person would notice.
   * ------------------------------------------------------------------ */

  test("no drawer, no sheet, no scrim, and no control claiming to open either", () => {
    for (const explorer of [true, false]) {
      const app = mountFrame(390, "the note", { explorer });
      expect(app.find("frame-drawer")).toBeNull();
      expect(app.find("frame-nav-sheet")).toBeNull();
      expect(app.find("frame-scrim")).toBeNull();
      expect(app.find("frame-drawer-toggle")).toBeNull();
      expect(app.find("frame-nav-toggle")).toBeNull();
      expect(app.find("rail-sheet")).toBeNull();
      app.unmount();
    }
  });

  /**
   * **The three branches that can still draw a panel, at every density and both
   * routes, in one place.**
   *
   * The block above and the pointer-layout ones cover most of this between
   * them, and "most" was the problem: the rail sheet was asserted absent at 390
   * and at 1440 and not at 1024, so the claim in `frame.ts` — that the drawings
   * are kept *and* unreachable — was true of a grid nobody had walked.
   *
   * It matters because those branches are deliberately kept. `frame.ts` keeps
   * the `sheet` and `drawer` arms of `Regions`, the `scrim`, and the two panel
   * flags on `FrameState`, because `AppFrame`'s API is held outside this
   * feature and retiring the representation is one coordinated change made
   * where those callers are. Kept code with nothing measuring its
   * unreachability is how "kept" becomes "back" without anybody deciding.
   */
  test.each([390, 1024, 1440])("no panel is drawn over the editor at %ipt", (width) => {
    for (const explorer of [true, false]) {
      const app = mountFrame(width, "the note", { explorer });
      expect(app.find("frame-drawer")).toBeNull();
      expect(app.find("frame-nav-sheet")).toBeNull();
      expect(app.find("frame-scrim")).toBeNull();
      // The peek is a panel over the editor too, and at rest it is not up —
      // nothing has folded the tree away, so there is no seam to rest on.
      expect(app.find("explorer-peek")).toBeNull();
      app.unmount();
    }
  });

  /**
   * **`rail: "hidden"` has left the kept-but-unreachable list, and this is the
   * assertion that says which density reaches it.**
   *
   * The block above asserts that three drawings stay unreachable. That claim
   * used to cover a fourth thing implicitly — the rail's `hidden` arm — and
   * focus mode reaches it now at medium and wide. Stating *where* is what stops
   * "kept" from quietly becoming "reachable again" in the other direction:
   * without this, deleting focus mode's branch would leave the arm unreachable
   * and nothing would notice.
   */
  test("focus mode folds the explorer away, the rail having gone already", () => {
    for (const width of [1024, 1440]) {
      const app = mountFrame(width, createElement(FocusProbe));
      // No rail at any density now: it is `SwitcherMenu` under the name in the
      // title bar. What focus still has to fold is the tree.
      expect(app.find("rail-full")).toBeNull();
      expect(app.find("rail-icons")).toBeNull();
      expect(app.find("explorer")).not.toBeNull();

      app.press("probe-toggle-focus");

      expect(app.find("rail-full")).toBeNull();
      expect(app.find("rail-icons")).toBeNull();
      expect(app.find("rail-sheet")).toBeNull();
      expect(app.find("explorer")).toBeNull();
      // And nothing came in over the note in its place.
      expect(app.find("frame-scrim")).toBeNull();
      expect(app.find("explorer-peek")).toBeNull();
      app.unmount();
    }
  });

  test("a phone has no focus mode, because it has no panels to fold", () => {
    const app = mountFrame(390, createElement(FocusProbe));

    app.press("probe-toggle-focus");

    // Unchanged, and in particular still carrying its bottom row: a chord that
    // wrote `focus` here would be setting a mode compact never reads, which is
    // the ⌘B failure this frame has had twice.
    expect(app.find("bottom")).not.toBeNull();
    expect(app.find("frame-focus-edge")).toBeNull();
    expect(app.find("rail-full")).toBeNull();

    app.unmount();
  });

  /**
   * **Both commands are no-ops here, driven through the frame's own API.**
   *
   * `appFrame.test.ts` asserts that `railToggleFor` and `explorerToggleFor`
   * answer `null` at compact. That is the rule; this is the frame obeying it,
   * and the two are worth having separately because the frame used to
   * implement a rule of its own — ⌘⇧E toggled the *rail* on any layout with an
   * explorer column, a duplicate of ⌘B that never touched the region it is
   * named after.
   *
   * "Does nothing" is asserted as *nothing appears and nothing disappears*,
   * rather than as a flag staying false: a command that quietly wrote state a
   * later render read would pass the weaker version.
   */
  test("⌘⇧E does nothing at all on a phone", () => {
    const app = mountFrame(390, createElement(TogglesProbe));
    const before = app.container.innerHTML;

    app.press("probe-toggle-explorer");
    app.press("probe-toggle-explorer");

    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();
    expect(app.find("bottom")).not.toBeNull();
    expect(app.container.innerHTML).toBe(before);

    app.unmount();
  });

  test("a stale panel flag from an older bundle draws nothing either", () => {
    // `FrameState` still carries `drawerOpen` and `panelsClearedFor` still
    // clears it — see `frame.ts` on why the representation outlived the panel.
    // What must not happen is a device that had it set coming back to a scrim.
    const app = mountFrame(390, "the note", { explorer: false });
    app.resize(1440);
    app.resize(390);
    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();
    app.unmount();
  });

  /* ------------------------------------------------------------------ *
   * The two slots that replaced them.
   * ------------------------------------------------------------------ */

  /**
   * The order is the assertion, and it is asserted as document order rather
   * than as "both are present".
   *
   * A pinned account mark, then the trailing capsule. Put the capsule first and
   * it stops being at the trailing edge; put the account after it and the one
   * sign-out in the product is no longer the thing at the leading corner.
   *
   * **There was a third slot between them and it is gone**: the contexts were a
   * `contextStrip` here, and a floating bar meant the note ran behind them at
   * every scroll position. They are the first row of `NavBand` now, inside the
   * scroller — `contextStrip.test.ts` and `noteChrome.test.ts` hold that end.
   *
   * SABOTAGE: rendered `topTrailing` before `accountSlot`. Fails here.
   */
  test("the top row is an account mark and the trailing group", () => {
    const app = mountFrame(390);
    const row = app.find("account")!.parentElement!.parentElement!;
    const order = [...row.querySelectorAll("[data-testid]")]
      .map((node) => (node as HTMLElement).dataset.testid)
      .filter((id) => id === "account" || id === "trailing");
    expect(order).toEqual(["account", "trailing"]);
    app.unmount();
  });

  /**
   * SABOTAGE: `flexShrink: 1` on `accountLead`. Fails here only.
   */
  test("the account mark is pinned rather than shrinkable", () => {
    // It holds the product's only sign-out. A flex child that may shrink is one
    // that whatever lands beside it later squeezes.
    const app = mountFrame(390);
    const lead = app.find("account")!.parentElement!;
    expect(styleOf(lead, "flex-shrink")).toBe("0");
    app.unmount();
  });

  /**
   * SABOTAGE: rendered the slot at every density (`compact ?` → `true ?`).
   * Fails here and in "the switcher chip is the pointer layout's" — the two
   * directions of the same swap, which is the right blast radius.
   */
  test("the account slot is not drawn on a pointer layout", () => {
    // It is the phone's leading slot. A pointer layout puts the switcher there
    // instead — `topBarLeadFor` is the fork — and everything the account block
    // offers is in that menu, under the workspace's own name.
    for (const width of [1024, 1440]) {
      const app = mountFrame(width);
      expect(app.find("account")).toBeNull();
      expect(app.find("switcher")).not.toBeNull();
      app.unmount();
    }
  });

  test("and the switcher chip is the pointer layout's, not the phone's", () => {
    // It used to be drawn at every density, and to be *pressable* on a phone —
    // it was how the rail sheet came in. The contexts are the navigation band
    // now, so the chip has nothing to say here that the band does not say
    // better.
    const app = mountFrame(390);
    expect(app.find("switcher")).toBeNull();
    app.unmount();

    const desktop = mountFrame(1440);
    expect(desktop.find("switcher")).not.toBeNull();
    desktop.unmount();
  });

  test("a frame given no account slot still draws its row rather than crashing", () => {
    // The landing page's picture of the console passes none, so an absent
    // leading slot is an ordinary state rather than an error one.
    const app = mountFrame(390, "the note", { accountSlot: false });
    expect(app.find("app-frame")).not.toBeNull();
    expect(app.text()).toContain("the note");
    expect(app.find("bottom")).not.toBeNull();
    app.unmount();
  });

  /**
   * ANYTHING FLOATING ABOVE THIS FRAME HAS TO KNOW THE TOOLBAR IS THERE.
   *
   * The persistent recording bar is mounted at the root of `(app)` — above every
   * route, so a recording is visible from wherever somebody is — which puts it
   * above this frame in the tree and out of reach of any context it provides. It
   * is a pill of exactly these dimensions in exactly this slot, so without this
   * height it would lie on top of the console's toolbar for the length of a
   * meeting. `features/app/bottomChrome.ts` is the seam; this is the assertion
   * that the frame actually publishes through it.
   *
   * **The panel half of this test is gone with the panels.** It pressed the
   * drawer toggle, checked the reservation dropped to zero because the toolbar
   * is put away under a panel, and checked it came back. `toolbarHidden` still
   * reads `regions.scrim`, and no density raises one — so what is left is the
   * publish and the teardown, which is the half a screen after this one
   * depends on.
   */
  test("the frame publishes the height of its floating toolbar, and takes it back", () => {
    const app = mountFrame(390);
    expect(bottomChromeHeight()).toBe(layout.bottomBarHeight);

    app.unmount();
    // A frame that has gone away leaves nothing behind, or every screen after
    // this one draws its bar 76pt up for a toolbar that is not there.
    expect(bottomChromeHeight()).toBe(0);
  });

  test("nothing is inert, because nothing is over the editor", () => {
    // The sheet used to put the note out of reach of the keyboard and the
    // screen reader, which was right while there was a sheet. With no panel at
    // this density, an `inert` editor would be a note nobody can Tab into and
    // nothing on screen to explain why.
    const app = mountFrame(390);
    expect(app.find("app-frame")!.querySelector("[inert]")).toBeNull();
    app.unmount();
  });

  test("search is on the toolbar, not doubled into the top bar", () => {
    // The one screen with least room must not carry the same control twice.
    const app = mountFrame(390);
    expect(app.find("frame-search")).toBeNull();
    app.unmount();
  });
});

describe("a desktop", () => {
  test("shows the explorer column and the status bar, and no rail", () => {
    const app = mountFrame(1440);

    expect(app.find("rail-full")).toBeNull();
    expect(app.find("rail-icons")).toBeNull();
    expect(app.find("explorer")).not.toBeNull();
    expect(app.find("status")).not.toBeNull();
    expect(app.find("frame-search")).not.toBeNull();

    app.unmount();
  });

  test("has no drawer, no scrim and no bottom toolbar", () => {
    const app = mountFrame(1440);

    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();
    expect(app.find("bottom")).toBeNull();
    expect(app.find("frame-drawer-toggle")).toBeNull();

    app.unmount();
  });

  test("has no sheet and no control to raise one — the rail is already there", () => {
    const app = mountFrame(1440);

    expect(app.find("frame-nav-toggle")).toBeNull();
    expect(app.find("frame-nav-sheet")).toBeNull();

    app.unmount();
  });

  test("the explorer column is resizable and starts at its resting width", () => {
    const app = mountFrame(1440);
    const resizer = app.find("explorer-resizer");

    expect(resizer).not.toBeNull();
    expect(styleOf(resizer!, "cursor")).toBe("col-resize");

    app.unmount();
  });
});

describe("a tablet", () => {
  test("gets the explorer column without paying for it", () => {
    /*
      It used to pay: a 1024pt window had room for the explorer column *or* the
      rail's labels, and this asserted the rail had been narrowed to its marks
      to buy the tree. The rail folded into `SwitcherMenu` and there is no
      third column to trade against, so what is left to hold is that a tablet
      draws exactly what a desktop does.
    */
    const app = mountFrame(1024);

    expect(app.find("explorer")).not.toBeNull();
    expect(app.find("switcher")).not.toBeNull();
    expect(app.find("status")).not.toBeNull();
    expect(app.find("bottom")).toBeNull();

    app.unmount();
  });

  test("the breakpoints are the tokens, not numbers typed into the component", () => {
    const phone = mountFrame(layout.narrowBreakpoint - 1);
    expect(phone.find("bottom")).not.toBeNull();
    expect(phone.find("switcher")).toBeNull();
    phone.unmount();

    const tablet = mountFrame(layout.narrowBreakpoint);
    expect(tablet.find("bottom")).toBeNull();
    expect(tablet.find("switcher")).not.toBeNull();
    tablet.unmount();

    const desktop = mountFrame(layout.wideBreakpoint);
    expect(desktop.find("switcher")).not.toBeNull();
    expect(desktop.find("explorer")).not.toBeNull();
    desktop.unmount();
  });
});

/* -------------------------------------------------------------------------- */

/**
 * A real pointer, driven over a node through react-native-web's own responder
 * system.
 *
 * Not a synthetic call of a component's handlers: the events go to the DOM
 * node, react-native-web's `ResponderSystem` grants the responder, builds the
 * touch history and derives `gestureState.dx` from it, and the component's
 * `PanResponder` config runs exactly as it does in a browser. That is what this
 * has to be, because the bug it covers was never in a handler body — it was a
 * `useMemo` rebuilding the responder mid-gesture, which only a real drag
 * against a real re-rendering component can see.
 *
 * Two jsdom details make it work, and both fail silently rather than loudly:
 *
 *  - **jsdom's `MouseEvent` has no `pageX`/`pageY`**, and the touch history is
 *    built from exactly those. Without them every `dx` comes out as nothing,
 *    the column never moves, and a drag test passes while testing no drag at
 *    all. They are defined on each event by hand.
 *  - a `mousemove` is discarded unless `buttons` still says a button is down.
 */
function pointerOn(node: HTMLElement) {
  const fire = (type: string, x: number, buttons: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons,
      clientX: x,
      clientY: 10,
    });
    Object.defineProperty(event, "pageX", { value: x });
    Object.defineProperty(event, "pageY", { value: 10 });
    act(() => {
      node.dispatchEvent(event);
    });
  };

  return {
    down: (x: number) => fire("mousedown", x, 1),
    move: (x: number) => fire("mousemove", x, 1),
    up: (x: number) => fire("mouseup", x, 0),
  };
}

describe("dragging the explorer's edge", () => {
  /** The width react-native-web actually wrote onto the explorer column. */
  function columnWidth(app: Mounted): number {
    const column = app.find("explorer")?.parentElement;
    if (column == null) throw new Error("no explorer column");
    return Number.parseFloat(column.style.width);
  }

  /** One press, a run of moves, one release. Returns the width after each move. */
  function drag(app: Mounted, from: number, through: number[]): number[] {
    const handle = app.find("explorer-resizer");
    if (handle === null) throw new Error("no resize handle");
    const pointer = pointerOn(handle);
    const widths: number[] = [];

    pointer.down(from);
    for (const x of through) {
      pointer.move(x);
      widths.push(columnWidth(app));
    }
    pointer.up(through.length === 0 ? from : through[through.length - 1]!);
    return widths;
  }

  test("the column follows the whole gesture, not its last frame", () => {
    const app = mountFrame(1440);
    expect(columnWidth(app)).toBe(layout.explorerWidth);

    // Press at 100, then move to 150, 200, 250 — +50, +100, +150 from where the
    // pointer went down. Sampling after every move is the point: the failure
    // this guards is *stuttering*, and a test that only read the end could be
    // satisfied by a drag that crawled there.
    //
    // Rebuilding the responder on each move — which is what listing `width` in
    // its `useMemo` deps does — gives 310, 310, 360 instead: react-native-web
    // allocates a fresh `gestureState` with `dx: 0` per instance while
    // `startWidth` still holds the grant-time width, so all but the last
    // increment is thrown away and the drag ends about a third short.
    expect(drag(app, 100, [150, 200, 250])).toEqual([310, 360, 410]);

    // The same claim in one line: where the pointer put it is where it is.
    expect(columnWidth(app)).toBe(layout.explorerWidth + 150);

    app.unmount();
  });

  test("the next drag starts from where the last one finished", () => {
    // The gesture's starting width is read through a ref at grant time. A ref
    // initialised once and never refreshed would send every later drag back to
    // the resting width — the other half of the same bug, and the reason the
    // ref is kept current by a commit rather than only by `useRef`'s initial
    // value.
    const app = mountFrame(1440);

    drag(app, 100, [250]);
    expect(columnWidth(app)).toBe(layout.explorerWidth + 150);

    drag(app, 400, [340]);
    expect(columnWidth(app)).toBe(layout.explorerWidth + 150 - 60);

    app.unmount();
  });

  test("the clamp still holds at both ends of a long drag", () => {
    const app = mountFrame(1440);

    drag(app, 100, [1400]);
    expect(columnWidth(app)).toBe(layout.explorerMaxWidth);

    /*
      **The floor still refuses to render anything narrower, and that is the
      half of this test that must not change.** What changed is only what a
      release past it means: the second half used to drag 900px left and assert
      the column sat at the floor afterwards, which now folds it away instead —
      so the claim is made *during* the gesture, where it is actually about the
      clamp, and the release is a separate test below.
    */
    const widths = drag(app, 400, [380, 360, 340, 300]).slice(0, -1);
    expect(widths.every((width) => width >= layout.explorerMinWidth)).toBe(true);

    app.unmount();
  });

  test("dragging past the floor and releasing folds the column away", () => {
    // The clamp's own comment gave the reason it refused rather than closing:
    // dragging to zero is how somebody hides a region and then wonders where it
    // went. That reason is answered by the seam left standing, not by the
    // refusal — so the drag can mean something past the floor now.
    const app = mountFrame(1440);
    const handle = app.find("explorer-resizer")!;
    const pointer = pointerOn(handle);

    pointer.down(400);
    pointer.move(400 - (layout.explorerWidth - layout.explorerMinWidth) - 60);
    // Armed, and saying so, before anything has been decided.
    expect(app.find("explorer-seam-arming")).not.toBeNull();
    expect(app.find("explorer")).not.toBeNull();

    pointer.up(400 - (layout.explorerWidth - layout.explorerMinWidth) - 60);

    expect(app.find("explorer")).toBeNull();
    expect(app.find("explorer-seam-closed")).not.toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    app.unmount();
  });

  test("a drag that stops short of the overshoot snaps back instead", () => {
    // The gap between the floor and the close is what stops a pull that
    // overshoots by a few pixels from folding the tree by accident.
    const app = mountFrame(1440);
    const handle = app.find("explorer-resizer")!;
    const pointer = pointerOn(handle);

    const justInside =
      400 - (layout.explorerWidth - layout.explorerMinWidth) - layout.explorerCloseOvershoot + 4;
    pointer.down(400);
    pointer.move(justInside);
    expect(app.find("explorer-seam-arming")).toBeNull();
    pointer.up(justInside);

    expect(app.find("explorer")).not.toBeNull();
    expect(columnWidth(app)).toBe(layout.explorerMinWidth);

    app.unmount();
  });

  test("the width somebody dragged to survives the fold", () => {
    // `explorerHidden` and `explorerWidth` are two fields precisely so that
    // re-opening does not have to invent a width.
    const app = mountFrame(1440);

    drag(app, 100, [180]);
    expect(columnWidth(app)).toBe(layout.explorerWidth + 80);

    app.press("status-toggle-explorer");
    expect(app.find("explorer")).toBeNull();
    app.press("explorer-seam-closed");

    expect(columnWidth(app)).toBe(layout.explorerWidth + 80);

    app.unmount();
  });

  test("the handle highlights for the length of the gesture and no longer", () => {
    const app = mountFrame(1440);
    const handle = app.find("explorer-resizer")!;
    const pointer = pointerOn(handle);
    const idle = styleOf(handle, "background-color");

    pointer.down(100);
    const held = styleOf(handle, "background-color");
    pointer.move(150);
    expect(styleOf(handle, "background-color")).toBe(held);
    pointer.up(150);

    expect(idle).toBe("rgba(0, 0, 0, 0)");
    expect(held).not.toBe(idle);
    expect(styleOf(handle, "background-color")).toBe(idle);

    app.unmount();
  });

  test("the handle lies over the border, after the editor that used to cover it", () => {
    /*
      **Where this node sits in the row is the whole of whether it can be
      pressed.** The strip straddles the column's border, because a target you
      can grab is wider than a hairline and people aim at the edge rather than a
      few points inside it — so half of it lies over the editor. Drawn as the
      column's last child, that half was drawn there and pressed nowhere: later
      siblings are on top and the editor is a later sibling, so it took every
      press that landed on the outer half.

      Measured in Chromium before the move: `elementFromPoint` at the middle of
      a 7pt handle answered the editor's region, not the handle.
    */
    const app = mountFrame(1440);
    const handle = app.find("explorer-resizer")!;
    const column = app.find("explorer")!.parentElement!;

    expect(column.contains(handle)).toBe(false);

    const row = Array.from(handle.parentElement!.children);
    const editor = row.findIndex((node) => node.textContent?.includes("the note"));
    expect(editor).toBeGreaterThanOrEqual(0);
    expect(row.indexOf(handle)).toBeGreaterThan(editor);

    // And it is laid over the border rather than beside it: three of its seven
    // points over the editor, the rest over the tree.
    expect(handle.style.left).toBe(
      `${layout.explorerWidth - layout.explorerSeamOverhang}px`,
    );

    app.unmount();
  });

  test("the handle follows the edge it is dragging", () => {
    // It is positioned from the column's width now rather than pinned to its
    // side, so the arithmetic has to hold for the length of a drag — a handle
    // left at the resting offset would walk away from the border it draws.
    const app = mountFrame(1440);

    drag(app, 100, [180]);

    expect(app.find("explorer-resizer")!.style.left).toBe(
      `${layout.explorerWidth + 80 - layout.explorerSeamOverhang}px`,
    );

    app.unmount();
  });

  /**
   * The browser deciding that a pointer dragged across text is a selection.
   *
   * Faithful to what a real drag does rather than convenient: the anchor is a
   * *text node*, because `isSelectionValid` — which is what react-native-web
   * asks before it terminates a gesture — ignores a selection whose ends are
   * both elements, and a test that selected the node's contents would arm
   * nothing and pass against the bug.
   */
  function selectTextIn(node: HTMLElement) {
    const text = node.firstChild;
    if (text == null || text.nodeType !== Node.TEXT_NODE) throw new Error("no text to select");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.textContent?.length ?? 0);
    const selection = window.getSelection();
    if (selection == null) throw new Error("no selection");
    selection.removeAllRanges();
    selection.addRange(range);
    act(() => {
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
  }

  test("a selection under the pointer does not end the drag", () => {
    /*
      **The bug this covers is the whole reason the drag felt one-directional.**
      A pointer moving with the button down is a text selection as far as the
      browser is concerned, and react-native-web's responder system terminates
      the current gesture the moment one becomes valid — `selectionchange` with
      a non-empty string over a text node is `onResponderTerminate`, and the
      default `onResponderTerminationRequest` says yes to it.

      Dragging the seam *left* crosses the tree's note names, so it hit that on
      the first row the pointer got ahead of; dragging *right* crosses
      CodeMirror's editing host, where a selection started outside it does not
      extend, so that direction never did. What was left was a handle that only
      worked while it was moved slowly enough to stay inside its own 7pt strip,
      where there is no text to select.
    */
    const app = mountFrame(1440);
    const handle = app.find("explorer-resizer")!;
    const pointer = pointerOn(handle);

    pointer.down(400);
    pointer.move(370);
    expect(columnWidth(app)).toBe(layout.explorerWidth - 30);

    selectTextIn(app.find("explorer")!);

    // The gesture is still the gesture: the next move is measured from where
    // the pointer went down, not from a fresh grant that never happened.
    pointer.move(340);
    expect(columnWidth(app)).toBe(layout.explorerWidth - 60);

    pointer.up(340);
    expect(columnWidth(app)).toBe(layout.explorerWidth - 60);

    app.unmount();
  });

  test("the drag holds the document still while it runs, and hands it back", () => {
    /*
      Refusing to hand the gesture over keeps the drag alive; this is what keeps
      the *page* from painting a selection across the tree underneath it, and
      keeps the resize cursor on the pointer once it is past the handle. Both
      are released on the way out — a page left unselectable after a drag is a
      worse bug than the one this fixes.
    */
    const app = mountFrame(1440);
    const handle = app.find("explorer-resizer")!;
    const pointer = pointerOn(handle);

    expect(document.body.style.getPropertyValue("user-select")).toBe("");

    pointer.down(400);
    expect(document.body.style.getPropertyValue("user-select")).toBe("none");
    expect(document.body.style.getPropertyValue("cursor")).toBe("col-resize");

    pointer.move(340);
    pointer.up(340);

    expect(document.body.style.getPropertyValue("user-select")).toBe("");
    expect(document.body.style.getPropertyValue("cursor")).toBe("");

    app.unmount();
  });

  test("a gesture the browser cancels hands the document back too", () => {
    // A native drag starting under the pointer takes the gesture away for real
    // — `dragstart` is a cancel, not a request — and the one thing that must
    // not survive it is an unselectable page.
    const app = mountFrame(1440);
    const handle = app.find("explorer-resizer")!;
    const pointer = pointerOn(handle);

    pointer.down(400);
    pointer.move(340);
    expect(document.body.style.getPropertyValue("user-select")).toBe("none");

    act(() => {
      document.dispatchEvent(new Event("dragstart", { bubbles: true }));
    });

    expect(document.body.style.getPropertyValue("user-select")).toBe("");
    // A cancel is not a release: the column stays where the drag left it and
    // nothing folds.
    expect(columnWidth(app)).toBe(layout.explorerWidth - 60);
    expect(app.find("explorer")).not.toBeNull();

    app.unmount();
  });

  test("unmounting mid-drag hands the document back", () => {
    // ⌘⇧E during a drag, or a rotation out of this density: the handle goes
    // away with the column and there is no release to tidy up after it.
    const app = mountFrame(1440);
    const pointer = pointerOn(app.find("explorer-resizer")!);

    pointer.down(400);
    expect(document.body.style.getPropertyValue("user-select")).toBe("none");

    app.unmount();

    expect(document.body.style.getPropertyValue("user-select")).toBe("");
    expect(document.body.style.getPropertyValue("cursor")).toBe("");
  });
});

describe("what toggling the explorer means", () => {
  /**
   * ⌘⇧E, reached through the frame's own API.
   *
   * On a phone the drawer button is on screen and the tests above press it. At
   * every other density there is no control for this at all — the keymap is the
   * only caller — so the command is invoked the way `console/_layout.tsx`
   * invokes it, through `useFrame()`.
   */
  function CommandProbe() {
    const frame = useFrame();
    return createElement(
      "button",
      { "data-testid": "probe-toggle-explorer", onClick: frame.toggleExplorer },
      "toggle the explorer",
    );
  }

  test("on a desktop it folds the column away and gives the width to the note", () => {
    /*
      **This reverses the assertion it replaces, and the old one is worth
      stating because it guarded a real defect.** It read "on a desktop it does
      nothing at all, rather than something else": `explorerToggleFor` answered
      `null` wherever the explorer was a permanent column, and `null` had to
      mean nothing happened, because this command used to collapse the *rail* —
      making ⌘⇧E a second ⌘B, a command named after the one region it never
      touched.

      The half that guarded the defect was "and the rail is untouched". There
      is no rail to be untouched now, so what stands in its place is the
      switcher and the note: a command that folded the tree and took the
      navigation with it would be the same failure wearing the new layout.
    */
    const app = mountFrame(1440, createElement(CommandProbe));

    app.press("probe-toggle-explorer");

    expect(app.find("explorer")).toBeNull();
    expect(app.find("switcher")).not.toBeNull();
    expect(app.find("status")).not.toBeNull();
    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    // And back, through the seam left where it was.
    app.press("explorer-seam-closed");
    expect(app.find("explorer")).not.toBeNull();
    expect(app.find("switcher")).not.toBeNull();

    app.unmount();
  });

  test("on a tablet it does the same thing, which it did not used to", () => {
    // Medium used to pay for the column with the rail's labels, so folding the
    // tree handed them back and this test watched the rail change width. There
    // is no rail to widen, so a tablet and a desktop answer alike.
    const app = mountFrame(1024, createElement(CommandProbe));

    expect(app.find("explorer")).not.toBeNull();

    app.press("probe-toggle-explorer");

    expect(app.find("explorer")).toBeNull();
    expect(app.find("switcher")).not.toBeNull();
    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    app.unmount();
  });

  test("on a pane with no tree it still does nothing at all", () => {
    // Map and Connections. Writing `explorerHidden` here would set a preference
    // on a pane that cannot show it, discovered later as a missing tree back on
    // Browse — the same shape as the defect the test above records.
    const app = mountFrame(1440, createElement(CommandProbe), { explorer: false });

    app.press("probe-toggle-explorer");

    expect(app.find("switcher")).not.toBeNull();
    expect(app.find("explorer-seam-closed")).toBeNull();
    expect(app.find("status-toggle-explorer")).toBeNull();

    app.unmount();
  });

  /**
   * **Three tests are replaced here, and what they asserted is worth keeping in
   * view because each was a real defect once.**
   *
   * *⌘B on a phone brings the rail in* — before that, ⌘B set `railCollapsed`,
   * which no compact layout reads, so the one surface with no other way to
   * navigate had a navigation chord that did nothing at all.
   *
   * *⌘⇧E on a pane with no tree leaves the rail alone* — before that, it
   * cleared `navOpen` on its way to setting a flag `regionsFor` discards, so on
   * Map, the pane you sign in to, the keystroke dismissed the only navigation
   * on the screen and opened nothing.
   *
   * *Raising the tree puts the rail away* — the two panels came in from the
   * same edge under one scrim, and a `toggleRail` that stopped clearing
   * `drawerOpen` looked right until you closed the sheet and the drawer sprang
   * open behind it.
   *
   * All three are about panels, and there are none at this density — nor is
   * there a ⌘B left to press anywhere, the rail having folded into the
   * switcher. What survives them is the *shape* of the danger: a command whose
   * density has nothing for it to do must do **nothing**, not another
   * command's job. That is one test now, and it is deliberately the strictest
   * form — the rendered output is compared before and after, so a command that
   * quietly wrote state a later render read would fail rather than pass a flag
   * check.
   */
  test("on a phone the tree's command is inert, at either route", () => {
    for (const explorer of [true, false]) {
      const app = mountFrame(390, createElement(TogglesProbe), { explorer });
      const before = app.container.innerHTML;

      app.press("probe-toggle-explorer");
      app.press("probe-toggle-explorer");

      expect(app.container.innerHTML).toBe(before);
      expect(app.find("frame-nav-sheet")).toBeNull();
      expect(app.find("frame-drawer")).toBeNull();
      expect(app.find("frame-scrim")).toBeNull();
      // And the navigation that is there is still there: a no-op that took the
      // account mark or the toolbar with it would be the old bug in a new place.
      expect(app.find("account")).not.toBeNull();
      expect(app.find("bottom")).not.toBeNull();

      app.unmount();
    }
  });
});

describe("the seams", () => {
  test("the tree's seam folds it and the closed seam brings it back", () => {
    /*
      The design: you fold a panel at its own edge, so the control that unfolds
      it is where the panel was, rather than forty points up and to the right
      in a toolbar.

      **There is one seam now and there were two.** The rail's own — a
      `PanelSeam` that narrowed the column to its marks — went with the rail
      and with ⌘B, which was the only other way to reach it. What that test
      asserted, a fold and an unfold from the panel's own edge, is asserted
      here of the panel that is left.
    */
    const app = mountFrame(1440);

    expect(app.find("explorer")).not.toBeNull();
    app.press("status-toggle-explorer");
    expect(app.find("explorer")).toBeNull();

    app.press("explorer-seam-closed");
    expect(app.find("explorer")).not.toBeNull();

    app.unmount();
  });

  test("there is no seam where there is no panel behind it", () => {
    // A control that folds something already folded is a button that lies, so
    // focus mode takes the seam with the panel.
    const app = mountFrame(1440, createElement(FocusProbe));
    expect(app.find("explorer-resizer")).not.toBeNull();

    app.press("probe-toggle-focus");
    expect(app.find("explorer-resizer")).toBeNull();
    expect(app.find("explorer-seam-closed")).toBeNull();

    app.unmount();
  });

  test("a phone has no seam at all", () => {
    const app = mountFrame(390);
    expect(app.find("explorer-seam-closed")).toBeNull();
    expect(app.find("explorer-resizer")).toBeNull();
    app.unmount();
  });

  test("the closed seam stays put underneath a peek", () => {
    // If it did not, the pointer resting on it would be resting on nothing the
    // moment the peek arrived, and the peek would close as fast as it opened.
    jest.useFakeTimers();
    const app = mountFrame(1440);
    app.press("status-toggle-explorer");

    const seam = app.find("explorer-seam-closed")!;
    hover(seam).in();
    act(() => {
      jest.advanceTimersByTime(400);
    });

    expect(app.find("explorer-peek")).not.toBeNull();
    expect(app.find("explorer-seam-closed")).not.toBeNull();

    app.unmount();
    jest.useRealTimers();
  });
});

describe("the peek", () => {
  /** A desktop with the tree folded away, which is the only state that peeks. */
  function folded(): Mounted {
    const app = mountFrame(1440);
    app.press("status-toggle-explorer");
    return app;
  }

  test("resting on the closed seam brings the tree back over the editor", () => {
    jest.useFakeTimers();
    const app = folded();
    expect(app.find("explorer")).toBeNull();

    hover(app.find("explorer-seam-closed")!).in();
    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(app.find("explorer-peek")).not.toBeNull();
    expect(app.find("explorer")).not.toBeNull();
    /*
      No scrim, which is the whole reason `peek` is an arm of `Regions.explorer`
      rather than the `drawer` with its scrim suppressed. A scrim would grey out
      and make inert the note being peeked at in order to reach.
    */
    expect(app.find("frame-scrim")).toBeNull();

    app.unmount();
    jest.useRealTimers();
  });

  test("crossing the seam on the way somewhere else opens nothing", () => {
    // The delay is the whole of what separates a rest from a traverse, and a
    // panel that opened on every pass would make the seam unusable.
    jest.useFakeTimers();
    const app = folded();
    const seam = app.find("explorer-seam-closed")!;

    hover(seam).in();
    act(() => {
      jest.advanceTimersByTime(120);
    });
    hover(seam).out();
    act(() => {
      jest.advanceTimersByTime(600);
    });

    expect(app.find("explorer-peek")).toBeNull();

    app.unmount();
    jest.useRealTimers();
  });

  test("leaving the panel closes it; leaving the seam does not", () => {
    /*
      The pointer leaving the seam is usually the pointer moving *onto* the
      panel that just opened beside it. Closing on the seam's hover-out would
      make the peek impossible to reach — it would vanish in the gap between the
      two elements.
    */
    jest.useFakeTimers();
    const app = folded();

    hover(app.find("explorer-seam-closed")!).in();
    act(() => {
      jest.advanceTimersByTime(300);
    });
    hover(app.find("explorer-seam-closed")!).out();
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(app.find("explorer-peek")).not.toBeNull();

    // The pointer arrives on the panel — which is where it was going when it
    // left the seam — and only then leaves for good.
    hover(app.find("explorer-peek")!).in();
    hover(app.find("explorer-peek")!).out();
    expect(app.find("explorer-peek")).toBeNull();

    app.unmount();
    jest.useRealTimers();
  });

  test("the panel is not a tab stop, because it is a hover surface", () => {
    /*
      `Pressable` gives every instance a `tabIndex`, and this file's scrim
      carries the rule: labelled and roleless, a screen reader announces a stop
      it cannot describe. This one would be roleless *and* nameless, sitting in
      the tab order between the rail and the note. The tree inside it keeps its
      own semantics, which is the whole reason the wrapper needs none.

      Asserted as an attribute rather than trusted to a prop, because the
      obvious spelling — `focusable={false}` — compiles, reads correctly, and
      does nothing: react-native-web's `Pressable` honours `tabIndex` and
      ignores `focusable`. This test is how that was found.
    */
    jest.useFakeTimers();
    const app = folded();

    hover(app.find("explorer-seam-closed")!).in();
    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(app.find("explorer-peek")!.getAttribute("tabindex")).toBe("-1");
    // The seam that summoned it is the opposite case and is reachable, named.
    expect(app.find("explorer-seam-closed")!.getAttribute("aria-label")).toBe("Open the file tree");

    app.unmount();
    jest.useRealTimers();
  });

  test("pressing the seam opens the column for good, and cancels the peek", () => {
    jest.useFakeTimers();
    const app = folded();

    hover(app.find("explorer-seam-closed")!).in();
    app.press("explorer-seam-closed");

    expect(app.find("explorer")).not.toBeNull();
    expect(app.find("explorer-peek")).toBeNull();
    expect(app.find("explorer-seam-closed")).toBeNull();

    // And the timer that was pending does not bring a peek back afterwards,
    // beside a column that is already there.
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(app.find("explorer-peek")).toBeNull();

    app.unmount();
    jest.useRealTimers();
  });

  test("a pending peek is cancelled when the frame goes away", () => {
    /*
      Navigating from Browse to Map with the pointer sitting on the seam.

      **Asserted against the timer itself, and the version this replaces is
      worth recording because it was the exact failure `docs/decisions/testing`
      is about.** It unmounted, advanced the clock and expected no throw — and
      it passed with the cleanup deleted, because React 19 removed the
      setState-on-an-unmounted-tree warning that the assertion was silently
      relying on. A guard nobody has checked is not a guard; the sabotage run
      is what checked it.

      Counting pending timers is the claim that actually fails: a timer left
      behind is a timer left behind whether or not anything downstream
      complains about it today.
    */
    jest.useFakeTimers();
    const app = folded();
    const before = jest.getTimerCount();

    hover(app.find("explorer-seam-closed")!).in();
    expect(jest.getTimerCount()).toBe(before + 1);

    app.unmount();
    expect(jest.getTimerCount()).toBe(before);

    jest.useRealTimers();
  });
});

describe("the status bar's panel toggle", () => {
  /**
   * **There was a second toggle here and it is gone rather than folded.**
   *
   * `status-toggle-rail` reported the rail's three states — `full`, `icons`
   * and `off` — and pressed ⌘B. The rail folded into `SwitcherMenu`, so that
   * control would have been a button reporting `off` forever and toggling
   * nothing: the one shape `frame.ts`'s "what is deliberately kept" list
   * refuses, a control with no region behind it. `PanelToggle`'s `half` arm
   * went with it, because the tree is drawn or it is not.
   *
   * What those tests asserted — that a keyboard can reach the state, that the
   * readout tracks the region, and that pressing one in focus mode is a way
   * out — is asserted here of the toggle that is left.
   */
  test("it is there on a desktop, and it says what is folded", () => {
    // The seam is the gesture and the status bar is the state. This is the half
    // that never moves, and the only one a keyboard reaches by tabbing.
    const app = mountFrame(1440);

    expect(app.find("status-toggle-rail")).toBeNull();
    expect(app.find("status-toggle-explorer")!.getAttribute("aria-checked")).toBe("true");

    app.press("status-toggle-explorer");
    expect(app.find("status-toggle-explorer")!.getAttribute("aria-checked")).toBe("false");
    expect(app.find("explorer")).toBeNull();

    app.press("status-toggle-explorer");
    expect(app.find("explorer")).not.toBeNull();

    app.unmount();
  });

  test("a phone has no status bar to put it in", () => {
    const app = mountFrame(390);
    expect(app.find("status-toggle-rail")).toBeNull();
    expect(app.find("status-toggle-explorer")).toBeNull();
    app.unmount();
  });

  test("it is absent on a pane with no tree, leaving the bar to the counts", () => {
    const app = mountFrame(1440, "the note", { explorer: false });
    expect(app.find("status")).not.toBeNull();
    expect(app.find("status-toggle-rail")).toBeNull();
    expect(app.find("status-toggle-explorer")).toBeNull();
    app.unmount();
  });

  test("it survives focus mode, which is what makes it leavable", () => {
    // Focus removes the panel, not the instruments. A mode that hides its own
    // escape hatch is one people enter exactly once.
    const app = mountFrame(1440, createElement(FocusProbe));

    app.press("probe-toggle-focus");

    expect(app.find("status")).not.toBeNull();
    expect(app.find("status-toggle-explorer")).not.toBeNull();
    expect(app.find("frame-focus-edge")).not.toBeNull();

    // And pressing it is a way out: a command naming a panel that is not on
    // the screen brings the panels back rather than writing a preference
    // nobody can see change.
    app.press("status-toggle-explorer");
    expect(app.find("explorer")).not.toBeNull();

    app.unmount();
  });

  test("the focus edge offers a way back before the pointer reaches the toggle", () => {
    const app = mountFrame(1440, createElement(FocusProbe));
    app.press("probe-toggle-focus");

    const edge = app.find("frame-focus-edge")!;
    expect(app.find("frame-focus-exit")).toBeNull();
    hover(edge).in();
    expect(app.find("frame-focus-exit")).not.toBeNull();

    app.press("frame-focus-edge");
    expect(app.find("explorer")).not.toBeNull();

    app.unmount();
  });
});
/* -------------------------------------------------------------------------- */

/**
 * ESCAPE CLOSES THE NEAREST THING, AND SAYS WHETHER IT CLOSED ANYTHING.
 *
 * `keymap.ts` promises Escape "closes whatever is open, wherever you are", and
 * the console keeps that promise by calling `closeOverlays()` — which knew
 * about the panels this component renders itself. Anything else over the console was outside the promise: the find bar
 * in the editor could be opened with ⌘F and then only closed from inside the
 * editor, which is what came back as "isn't dismissable".
 *
 * A panel the frame does not render registers a closer instead. The rules are
 * the three below: nearest first, the boolean is honest, and a panel that
 * unmounted is not a panel.
 */
describe("a panel the frame does not render can still be closed by Escape", () => {
  interface Probe {
    /** Whether the imagined panel is up. */
    open: boolean;
    /** How many times the frame asked it to close. */
    asked: number;
    /** What `closeOverlays()` answered, press by press. */
    answers: boolean[];
  }

  function probe(): Probe {
    return { open: false, asked: 0, answers: [] };
  }

  /** The panel's half: it registers a closer for as long as it is mounted. */
  function Registrant({ state }: { state: Probe }) {
    const { registerDismissable } = useFrame();
    useEffect(
      () =>
        registerDismissable(() => {
          state.asked += 1;
          if (!state.open) return false;
          state.open = false;
          return true;
        }),
      [registerDismissable, state],
    );
    return null;
  }

  /** The console's half: Escape, and a panel that can go away. */
  function DismissProbe({ state }: { state: Probe }) {
    const frame = useFrame();
    const [mounted, setMounted] = useState(true);
    return createElement(
      "span",
      null,
      mounted ? createElement(Registrant, { state }) : null,
      createElement(
        "button",
        {
          "data-testid": "probe-escape",
          onClick: () => state.answers.push(frame.closeOverlays()),
        },
        "escape",
      ),
      createElement(
        "button",
        { "data-testid": "probe-unmount", onClick: () => setMounted(false) },
        "close the note",
      ),
    );
  }

  test("Escape closes it, and answers that it closed something", () => {
    const state = probe();
    state.open = true;
    const app = mountFrame(1440, createElement(DismissProbe, { state }));

    app.press("probe-escape");

    expect(state.open).toBe(false);
    expect(state.answers).toEqual([true]);

    app.unmount();
  });

  /**
   * The boolean is not decoration. `Shortcuts` returns it from the `dismiss`
   * command, and `useKeymap` only calls `preventDefault` on a `true` — so a
   * closer that closed nothing answering `true` would take the browser's own
   * Escape away from a console with nothing open on it.
   */
  test("with nothing open it answers false, so Escape still reaches the browser", () => {
    const state = probe();
    const app = mountFrame(1440, createElement(DismissProbe, { state }));

    app.press("probe-escape");

    expect(state.asked).toBe(1);
    expect(state.answers).toEqual([false]);

    app.unmount();
  });

  /**
   * Nearest first, which is last registered first.
   *
   * A find bar lies over the note inside the console the drawer covers, so one
   * Escape must not take both — the next press is what the thing behind it is
   * for. The two panels this component renders itself (the drawer, the rail
   * sheet) are behind every registered closer for the same reason, and are
   * closed only once none of them answered.
   */
  test("the nearer panel closes, and the one behind it is not even asked", () => {
    const near = probe();
    const far = probe();
    near.open = true;
    far.open = true;
    const app = mountFrame(
      1440,
      createElement(
        "span",
        null,
        // Registered first, so it is the one further from the person.
        createElement(Registrant, { state: far }),
        createElement(DismissProbe, { state: near }),
      ),
    );

    app.press("probe-escape");

    expect(near.open).toBe(false);
    expect(far.open).toBe(true);
    expect(far.asked).toBe(0);

    app.press("probe-escape");

    expect(far.open).toBe(false);
    expect(near.answers).toEqual([true, true]);

    app.unmount();
  });

  /**
   * A note closed with the find bar open leaves a closer pointing at an editor
   * that no longer exists. Registration is for the life of the mount, and the
   * frame must not hold the last one — that is a leak on the app's most
   * frequent unmount, and an Escape answering `true` for a panel nobody can see.
   */
  test("a panel that unmounted is not asked again", () => {
    const state = probe();
    state.open = true;
    const app = mountFrame(1440, createElement(DismissProbe, { state }));

    app.press("probe-unmount");
    app.press("probe-escape");

    expect(state.asked).toBe(0);
    expect(state.open).toBe(true);
    expect(state.answers).toEqual([false]);

    app.unmount();
  });
});


/**
 * THE TAB SLOT IS THE POINTER LAYOUT'S, AND THE FRAME SAYS SO ITSELF.
 *
 * Tabs are a pointer instrument — a phone has `RecentSheet` over `history.ts`
 * — and `console/_layout.tsx` has always guarded the slot with `!phone`. That
 * guard is worth keeping, because it avoids building a strip nothing will
 * draw, but it is the *caller's*, and a prop whose contract lives only in its
 * callers is one a caller can break in silence.
 *
 * One did. `AppFrameVisualFixture` passed `tabs` unconditionally, so a 390pt
 * board came back with a pointer tab strip lying across the top of the phone's
 * note. Nothing in the suite failed; it was visible only in a screenshot taken
 * to compare against the design canvas — which is exactly the class of bug
 * this file exists to convert into a failing test.
 *
 * `mountFrame` now passes `tabs` at every width for that reason.
 */
describe("the tab slot belongs to the pointer layout", () => {
  test("a wide window draws it", () => {
    const frame = mountFrame(1280);
    expect(frame.find("tabs")).not.toBeNull();
    frame.unmount();
  });

  test("a phone does not, however unconditionally it is passed", () => {
    const frame = mountFrame(390);
    expect(frame.find("tabs")).toBeNull();
    frame.unmount();
  });

  test("and a rotation into a phone width takes it away again", () => {
    // The live case: a window dragged narrow, not a fresh mount. The slot is a
    // render-time condition rather than a mount-time one, and this is what
    // says so.
    const frame = mountFrame(1280);
    expect(frame.find("tabs")).not.toBeNull();

    act(() => frame.resize(390));
    expect(frame.find("tabs")).toBeNull();
    frame.unmount();
  });
});
