/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactNode } from "react";
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
  options: { explorer?: boolean; accountSlot?: boolean; contextStrip?: boolean } = {},
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
          The two compact slots, as stubs. `AppFrame` "knows about geometry and
          nothing else", so what a test needs from them is that they are laid
          out in the right places and drawn at the right densities — what they
          contain is `ContextStrip`'s business and `contextStrip.test.ts`'s.
        */
        accountSlot:
          options.accountSlot === false
            ? undefined
            : createElement("span", { "data-testid": "account" }, "you"),
        contextStrip:
          options.contextStrip === false
            ? undefined
            : createElement("span", { "data-testid": "strip" }, "contexts"),
        // The trailing capsule, which the strip beside it may never push off
        // the glass — the controls in it act on the note.
        topTrailing: createElement("span", { "data-testid": "trailing" }, "actions"),
        rail: (mode: "full" | "icons" | "sheet") =>
          createElement("span", { "data-testid": `rail-${mode}` }, "rail"),
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
  return createElement(
    "span",
    null,
    createElement(
      "button",
      { "data-testid": "probe-toggle-rail", onClick: frame.toggleRail },
      "toggle the rail",
    ),
    createElement(
      "button",
      { "data-testid": "probe-toggle-explorer", onClick: frame.toggleExplorer },
      "toggle the explorer",
    ),
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
      app.unmount();
    }
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
  test("⌘B and ⌘⇧E do nothing at all on a phone", () => {
    const app = mountFrame(390, createElement(TogglesProbe));
    const before = app.container.innerHTML;

    app.press("probe-toggle-rail");
    app.press("probe-toggle-explorer");
    app.press("probe-toggle-rail");

    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();
    expect(app.find("bottom")).not.toBeNull();
    expect(app.container.innerHTML).toBe(before);

    app.unmount();
  });

  test("a stale panel flag from an older bundle draws nothing either", () => {
    // `FrameState` still carries both flags and `panelsClearedFor` still clears
    // them — see `frame.ts` on why the representation outlived the panels. What
    // must not happen is a device that had one set coming back to a scrim.
    const app = mountFrame(390, "the note", { explorer: false });
    app.resize(1440);
    app.resize(390);
    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();
    app.unmount();
  });

  /* ------------------------------------------------------------------ *
   * The three slots that replaced them.
   * ------------------------------------------------------------------ */

  /**
   * The order is the assertion, and it is asserted as document order rather
   * than as "all three are present".
   *
   * A pinned account mark, then the contexts, then the trailing capsule. Get
   * the middle one anywhere else and the strip is no longer the thing that
   * flexes: put it after the capsule and the capsule stops being at the
   * trailing edge; put the account inside the strip and a long list of contexts
   * scrolls a person's own identity off the glass.
   *
   * SABOTAGE: rendered `contextStrip` before `accountSlot`. Fails here.
   */
  test("the top row is an account mark, the contexts, and the trailing group", () => {
    const app = mountFrame(390);
    const row = app.find("account")!.parentElement!.parentElement!;
    const order = [...row.querySelectorAll("[data-testid]")]
      .map((node) => (node as HTMLElement).dataset.testid)
      .filter((id) => id === "account" || id === "strip" || id === "trailing");
    expect(order).toEqual(["account", "strip", "trailing"]);
    app.unmount();
  });

  /**
   * SABOTAGE: `flexShrink: 1` on `accountLead`. Fails here only.
   */
  test("the account mark is pinned, and the strip is what gives way", () => {
    // The mark is the first child of a row whose second child is a list. A
    // flex child that may shrink is one the list squeezes the moment somebody
    // joins a fourth workspace.
    const app = mountFrame(390);
    const lead = app.find("account")!.parentElement!;
    expect(styleOf(lead, "flex-shrink")).toBe("0");
    app.unmount();
  });

  /**
   * SABOTAGE: rendered the two slots at every density (`compact ?` → `true ?`).
   * Fails here and in "the switcher chip is the pointer layout's" — the two
   * directions of the same swap, which is the right blast radius.
   */
  test("neither slot is drawn on a pointer layout", () => {
    // They are the phone's answer to a rail that is a real column at these
    // widths. Drawing both would be the contexts listed twice on one screen.
    for (const width of [1024, 1440]) {
      const app = mountFrame(width);
      expect(app.find("account")).toBeNull();
      expect(app.find("strip")).toBeNull();
      expect(app.find("rail-full") ?? app.find("rail-icons")).not.toBeNull();
      app.unmount();
    }
  });

  test("and the switcher chip is the pointer layout's, not the phone's", () => {
    // It used to be drawn at every density, and to be *pressable* on a phone —
    // it was how the rail sheet came in. The contexts are the strip now, so the
    // chip has nothing to say here that the strip does not say better.
    const app = mountFrame(390);
    expect(app.find("switcher")).toBeNull();
    app.unmount();

    const desktop = mountFrame(1440);
    expect(desktop.find("switcher")).not.toBeNull();
    desktop.unmount();
  });

  test("a frame given neither slot still draws its row rather than crashing", () => {
    // The landing page's picture of the console passes neither, and a phone
    // with exactly one context is given a `ContextStrip` that renders `null`
    // (see `stripEntries`) — so an absent middle is an ordinary state, not an
    // error one.
    const app = mountFrame(390, "the note", { accountSlot: false, contextStrip: false });
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
  test("shows the rail, the explorer column and the status bar at once", () => {
    const app = mountFrame(1440);

    expect(app.find("rail-full")).not.toBeNull();
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
  test("keeps the explorer column and pays for it with the rail's labels", () => {
    const app = mountFrame(1024);

    expect(app.find("rail-icons")).not.toBeNull();
    expect(app.find("rail-full")).toBeNull();
    expect(app.find("explorer")).not.toBeNull();
    expect(app.find("bottom")).toBeNull();

    app.unmount();
  });

  test("the breakpoints are the tokens, not numbers typed into the component", () => {
    const phone = mountFrame(layout.narrowBreakpoint - 1);
    expect(phone.find("bottom")).not.toBeNull();
    phone.unmount();

    const tablet = mountFrame(layout.narrowBreakpoint);
    expect(tablet.find("bottom")).toBeNull();
    expect(tablet.find("rail-icons")).not.toBeNull();
    tablet.unmount();

    const desktop = mountFrame(layout.wideBreakpoint);
    expect(desktop.find("rail-full")).not.toBeNull();
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

    drag(app, 400, [-900]);
    expect(columnWidth(app)).toBe(layout.explorerMinWidth);

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

  test("on a desktop it does nothing at all, rather than something else", () => {
    // `explorerToggleFor` answers `null` wherever the explorer is a permanent
    // column, and `null` has to mean nothing happened. This used to collapse
    // the rail, which made ⌘⇧E a second ⌘B — a command named after the one
    // region it never touched.
    const app = mountFrame(1440, createElement(CommandProbe));

    app.press("probe-toggle-explorer");

    expect(app.find("rail-full")).not.toBeNull();
    expect(app.find("rail-icons")).toBeNull();
    expect(app.find("explorer")).not.toBeNull();
    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    app.unmount();
  });

  test("on a tablet it does nothing either, and cannot summon a drawer", () => {
    const app = mountFrame(1024, createElement(CommandProbe));

    app.press("probe-toggle-explorer");

    expect(app.find("rail-icons")).not.toBeNull();
    expect(app.find("rail-full")).toBeNull();
    expect(app.find("explorer")).not.toBeNull();
    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    app.unmount();
  });

  test("⌘B still collapses the rail, so the two commands stay distinct", () => {
    const app = mountFrame(1440, createElement(TogglesProbe));

    app.press("probe-toggle-rail");
    expect(app.find("rail-icons")).not.toBeNull();
    expect(app.find("rail-full")).toBeNull();

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
   * All three are about panels, and there are none at this density. What
   * survives them is the *shape* of the danger: a command whose density has
   * nothing for it to do must do **nothing**, not the other command's job. That
   * is one test now, and it is deliberately the strictest form — the rendered
   * output is compared before and after, so a command that quietly wrote state
   * a later render read would fail rather than pass a flag check.
   */
  test("on a phone both commands are inert, at either route", () => {
    for (const explorer of [true, false]) {
      const app = mountFrame(390, createElement(TogglesProbe), { explorer });
      const before = app.container.innerHTML;

      app.press("probe-toggle-rail");
      app.press("probe-toggle-explorer");
      app.press("probe-toggle-explorer");
      app.press("probe-toggle-rail");

      expect(app.container.innerHTML).toBe(before);
      expect(app.find("frame-nav-sheet")).toBeNull();
      expect(app.find("frame-drawer")).toBeNull();
      expect(app.find("frame-scrim")).toBeNull();
      // And the navigation that is there is still there: a no-op that took the
      // strip or the toolbar with it would be the old bug in a new place.
      expect(app.find("strip")).not.toBeNull();
      expect(app.find("account")).not.toBeNull();
      expect(app.find("bottom")).not.toBeNull();

      app.unmount();
    }
  });
});
