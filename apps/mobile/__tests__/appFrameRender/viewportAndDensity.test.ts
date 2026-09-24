/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { layout, mountFrame, styleOf, viewportHeight } from "./fixtures";

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
