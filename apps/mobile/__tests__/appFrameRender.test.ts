/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

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
  unmount: () => void;
}

function mountFrame(width: number, children: ReactNode = "the note"): Mounted {
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
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  act(() => {
    root.render(
      createElement(AppFrame, {
        switcher: createElement("span", { "data-testid": "switcher" }, "@seyi"),
        rail: (mode: "full" | "icons") =>
          createElement("span", { "data-testid": `rail-${mode}` }, "rail"),
        explorer: createElement("span", { "data-testid": "explorer" }, "tree"),
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

  function RailProbe() {
    const frame = useFrame();
    return createElement(
      "button",
      { "data-testid": "probe-toggle-rail", onClick: frame.toggleRail },
      "toggle the rail",
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
});
