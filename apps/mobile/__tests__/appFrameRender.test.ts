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
  options: { explorer?: boolean } = {},
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
        switcherLabel: "@seyi, personal",
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
 * ⌘B, and the vault switcher — reached through the frame's own API.
 *
 * Module level because two describes need it. On a phone with a file tree there
 * is no rail control in the top bar any more: it is the vault switcher at the
 * foot of the tree, which `_layout` passes into `Explorer`'s `vault` slot. The
 * explorer is a stub here, so the command is invoked the way that switcher
 * invokes it.
 */
function RailProbe() {
  const frame = useFrame();
  return createElement(
    "button",
    { "data-testid": "probe-toggle-rail", onClick: frame.toggleRail },
    "toggle the rail",
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

  test("is the editor and a bottom toolbar, with no rail", () => {
    const app = mountFrame(390);

    expect(app.text()).toContain("the note");
    expect(app.find("bottom")).not.toBeNull();
    expect(app.find("status")).toBeNull();
    expect(app.find("rail-full")).toBeNull();
    expect(app.find("rail-icons")).toBeNull();
    // The tree is not merely off-screen — it is not mounted, so it costs
    // nothing until it is asked for.
    expect(app.find("explorer")).toBeNull();

    app.unmount();
  });

  test("the drawer button brings in the tree and the scrim", () => {
    const app = mountFrame(390);

    expect(app.find("frame-drawer-toggle")).not.toBeNull();
    app.press("frame-drawer-toggle");

    expect(app.find("frame-drawer")).not.toBeNull();
    expect(app.find("explorer")).not.toBeNull();
    expect(app.find("frame-scrim")).not.toBeNull();

    app.unmount();
  });

  test("the scrim closes it again", () => {
    const app = mountFrame(390);
    app.press("frame-drawer-toggle");
    app.press("frame-scrim");

    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    app.unmount();
  });

  test("the switcher opens the rail as a sheet, over a scrim", () => {
    // The bug: signing in lands on Map, which has no explorer, so the drawer
    // button is absent — and the rail was never mounted at this width. The
    // whole screen was one pane and no way off it. Mounted here WITHOUT an
    // explorer, because that is the pane the bug was reported on.
    const app = mountFrame(390, "the note", { explorer: false });

    expect(app.find("frame-nav-toggle")).not.toBeNull();
    expect(app.find("frame-drawer-toggle")).toBeNull();
    expect(app.find("rail-sheet")).toBeNull();

    app.press("frame-nav-toggle");

    const sheet = app.find("frame-nav-sheet");
    expect(sheet).not.toBeNull();
    expect(app.find("frame-scrim")).not.toBeNull();

    // `sheet`, not `full`: same labels, thumb-sized rows. And the rail must be
    // INSIDE the sheet — asserting only that the node exists somewhere lets a
    // layout that renders the column *and* the sheet pass.
    const rail = app.find("rail-sheet");
    expect(rail).not.toBeNull();
    expect(sheet!.contains(rail)).toBe(true);
    expect(app.find("rail-full")).toBeNull();
    expect(app.find("rail-icons")).toBeNull();

    // ...and exactly one navigation landmark on the screen.
    expect(app.container.querySelectorAll('[role="navigation"]')).toHaveLength(1);

    app.unmount();
  });

  test("the toggle is named by what the switcher says, on every platform", () => {
    // A route with no tree, which is where the chip lives now — see the test
    // above it and `Regions.navToggle`.
    const app = mountFrame(390, "the note", { explorer: false });
    const toggle = app.find("frame-nav-toggle")!;

    // Spelled out rather than derived from the content. On web the content
    // would do, but `aria-hidden` on a `Text` is dropped on native and
    // `RCTRecursiveAccessibilityLabel` would fold the chevron into the name —
    // "@seyi personal black down-pointing small triangle".
    expect(toggle.getAttribute("aria-label")).toBe("@seyi, personal");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    app.press("frame-nav-toggle");
    expect(app.find("frame-nav-toggle")!.getAttribute("aria-expanded")).toBe("true");

    app.unmount();
  });

  test("the chevron turns over, and is hidden from the name", () => {
    const app = mountFrame(390, "the note", { explorer: false });
    /*
      Read off `data-icon` rather than off text. The chevron is drawn from
      `View`s now and contributes no text content at all, so the previous
      form of this assertion — comparing `textContent` to `▾` — would pass
      against a control that had stopped drawing a chevron entirely. See
      `design/components/Icon`, which carries the attribute for this reason.
    */
    const chevron = () =>
      app.find("frame-nav-toggle")!.querySelector("[data-icon]")?.getAttribute("data-icon");

    expect(chevron()).toBe("chevronDown");
    app.press("frame-nav-toggle");
    expect(chevron()).toBe("chevronUp");

    app.unmount();
  });

  test("what the sheet covers is out of reach of the keyboard too", () => {
    // Without this, Tab from the switcher lands in the note the sheet is
    // covering, and a screen reader walks the whole editor before reaching the
    // navigation somebody just asked for.
    const app = mountFrame(390, "the note", { explorer: false });
    const editor = () => app.find("app-frame")!.querySelector("[inert]");

    expect(editor()).toBeNull();
    app.press("frame-nav-toggle");
    expect(editor()).not.toBeNull();
    expect(editor()!.textContent).toContain("the note");

    app.press("frame-scrim");
    expect(editor()).toBeNull();

    app.unmount();
  });

  test("the scrim announces as a control rather than as a mystery tab stop", () => {
    const app = mountFrame(390, "the note", { explorer: false });
    app.press("frame-nav-toggle");
    const scrim = app.find("frame-scrim")!;

    // `Pressable` always takes a tab stop. Focusable and labelled but roleless
    // is a stop a screen reader cannot describe — and Space would not fire it.
    expect(scrim.getAttribute("aria-label")).toBe("Close this panel");
    expect(scrim.tagName.toLowerCase()).toBe("button");

    app.unmount();
  });

  test("a panel does not come back after a trip through a wider layout", () => {
    // `navOpen` is never cleared by a resize, and nothing at medium or wide can
    // clear it — no sheet, no scrim, no toggle, and ⌘B means `railCollapsed`
    // there. So it waited. Rotate an iPad out of portrait and back and a sheet
    // you never raised is over your note behind a full-body scrim.
    const app = mountFrame(390, "the note", { explorer: false });

    app.press("frame-nav-toggle");
    expect(app.find("frame-nav-sheet")).not.toBeNull();

    app.resize(1440);
    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("rail-full")).not.toBeNull();

    app.resize(390);
    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    app.unmount();
  });

  test("and neither does the tree drawer", () => {
    // Same defect, same fix — asserted separately so a `panelsClearedFor` that
    // only remembers one of the two fields fails here.
    const app = mountFrame(390);

    app.press("frame-drawer-toggle");
    expect(app.find("frame-drawer")).not.toBeNull();

    app.resize(1440);
    app.resize(390);
    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    app.unmount();
  });

  test("the control that opens it is a thumb-sized target", () => {
    // It is the primary navigation on this surface, and the chip inside it is
    // about 32pt tall. `BottomBar` holds the bottom row to this floor; a control in
    // the top bar that every phone session has to hit is not exempt from it.
    const app = mountFrame(390, "the note", { explorer: false });
    const toggle = app.find("frame-nav-toggle")!;

    expect(Number.parseFloat(styleOf(toggle, "min-height"))).toBeGreaterThanOrEqual(
      layout.minTouchTarget,
    );

    app.unmount();
  });

  test("the scrim closes the sheet, and so does the switcher again", () => {
    const app = mountFrame(390, "the note", { explorer: false });

    app.press("frame-nav-toggle");
    app.press("frame-scrim");
    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    app.press("frame-nav-toggle");
    expect(app.find("frame-nav-sheet")).not.toBeNull();
    app.press("frame-nav-toggle");
    expect(app.find("frame-nav-sheet")).toBeNull();

    app.unmount();
  });

  test("raising one panel puts the other away", () => {
    // They come in from the same edge under the same scrim. Two at once is a
    // panel hidden behind a panel.
    //
    // The rail is raised through `toggleRail` rather than through a top-bar
    // chip, because on a route *with* a tree there is no chip — the control is
    // the vault switcher at the foot of that tree, and the tree is a stub here.
    // See `RailProbe`.
    const app = mountFrame(390, createElement(RailProbe));

    app.press("probe-toggle-rail");
    app.press("frame-drawer-toggle");
    expect(app.find("frame-drawer")).not.toBeNull();
    expect(app.find("frame-nav-sheet")).toBeNull();

    app.press("probe-toggle-rail");
    expect(app.find("frame-nav-sheet")).not.toBeNull();
    expect(app.find("frame-drawer")).toBeNull();

    app.unmount();
  });

  test("the top bar over a note is a toggle and one group, and nothing between", () => {
    /*
      The complaint this whole branch answers, as an assertion.

      Obsidian's reading view spends one transparent row on chrome: a sidebar
      toggle at the leading edge and one grouped container at the trailing edge.
      Ours spent two — a row carrying the toggle *and* a context chip, and a
      breadcrumb row under it. The breadcrumb is gone from the pane; this is the
      other half, and it is the half that is easy to put back by "just" dropping
      a control into the middle of the bar.

      On a route with a tree the context chip is the vault switcher at the foot
      of that tree, so nothing here names the context at all.
    */
    const app = mountFrame(390);

    expect(app.find("frame-drawer-toggle")).not.toBeNull();
    expect(app.find("frame-nav-toggle")).toBeNull();
    expect(app.find("switcher")).toBeNull();
    expect(app.find("frame-search")).toBeNull();

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

  test("on a phone it pulls the drawer in, and puts it back", () => {
    const app = mountFrame(390, createElement(CommandProbe));

    app.press("probe-toggle-explorer");
    expect(app.find("frame-drawer")).not.toBeNull();
    expect(app.find("frame-scrim")).not.toBeNull();

    app.press("probe-toggle-explorer");
    expect(app.find("frame-drawer")).toBeNull();

    app.unmount();
  });

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
    const app = mountFrame(1440, createElement(RailProbe));

    app.press("probe-toggle-rail");
    expect(app.find("rail-icons")).not.toBeNull();
    expect(app.find("rail-full")).toBeNull();

    app.unmount();
  });

  test("⌘B on a phone brings the rail in, because there is nothing to collapse", () => {
    // It used to set `railCollapsed`, which no compact layout reads — so the
    // one surface with no other way to navigate had a navigation chord that
    // did nothing at all.
    const app = mountFrame(390, createElement(RailProbe));

    app.press("probe-toggle-rail");
    expect(app.find("frame-nav-sheet")).not.toBeNull();
    expect(app.find("rail-sheet")).not.toBeNull();

    app.press("probe-toggle-rail");
    expect(app.find("frame-nav-sheet")).toBeNull();

    app.unmount();
  });

  test("⌘⇧E on a pane with no tree leaves the rail alone", () => {
    // It used to clear `navOpen` on its way to setting a flag `regionsFor`
    // discards — so on Map, the pane you sign in to, the keystroke dismissed
    // the only navigation on the screen and opened nothing. Before the sheet
    // existed the same key was an inert no-op there, which is what it must go
    // back to being.
    const app = mountFrame(390, createElement(CommandProbe), { explorer: false });

    app.press("frame-nav-toggle");
    expect(app.find("frame-nav-sheet")).not.toBeNull();

    app.press("probe-toggle-explorer");

    expect(app.find("frame-nav-sheet")).not.toBeNull();
    expect(app.find("frame-drawer")).toBeNull();

    app.unmount();
  });

  test("raising the tree puts the rail away, and closing it leaves nothing behind", () => {
    // Both directions, because `regionsFor`'s rail-wins precedence hides a
    // `toggleRail` that stops clearing `drawerOpen`: the sheet still looks
    // right, and the drawer springs open the moment you close it.
    // Both probes: with a tree on the route the rail has no control in the top
    // bar, so `toggleRail` is reached the way the vault switcher reaches it.
    const app = mountFrame(
      390,
      createElement("div", null, createElement(CommandProbe), createElement(RailProbe)),
    );

    app.press("probe-toggle-rail");
    app.press("probe-toggle-explorer");
    expect(app.find("frame-drawer")).not.toBeNull();
    expect(app.find("frame-nav-sheet")).toBeNull();

    app.press("probe-toggle-rail");
    app.press("probe-toggle-rail");
    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    app.unmount();
  });
});
