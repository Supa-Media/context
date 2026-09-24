/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import {
  appRegionOf,
  installMacShell,
  layout,
  mountFrame,
  removeShell,
  setTopChromeHoldsLights,
  SHELL_TITLE_BAND_LEAD_PX,
  styleOf,
  TogglesProbe,
  topChromeHoldsLights,
} from "./fixtures";

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

/* -------------------------------------------------------------------------- */
/* the desktop shell's traffic lights, in the bar rather than above it         */
/* -------------------------------------------------------------------------- */

/**
 * THE 45PT BAND ABOVE THE 45PT BAR.
 *
 * `docs/decisions/desktop.md`, "The band moves into the bar". Inside the shell
 * the console drew an empty reservation strip on top of a top bar exactly as
 * tall — 90pt of chrome before the first note, half of it blank, where the Mac
 * apps this is compared to put the buttons *in* the bar.
 *
 * `shellTitleBand.test.ts` pins the rules and the band's own two components.
 * What is only checkable here is the bar itself: that it leaves the room, that
 * it becomes the window's handle, and that **every slot a route fills opts
 * back out** — the failure this change was warned about, where a click on the
 * context chip drags the window instead of opening the switcher.
 */
describe("the top bar holds the traffic lights", () => {
  beforeEach(() => {
    removeShell();
    setTopChromeHoldsLights("appframe-render-test", false);
  });

  afterEach(() => {
    removeShell();
    setTopChromeHoldsLights("appframe-render-test", false);
  });

  test("a Mac shell at a pointer density: the bar leaves the room and takes the job", () => {
    installMacShell();
    const mounted = mountFrame(1400);

    const bar = mounted.find("app-top-bar");
    expect(bar).not.toBeNull();
    expect(styleOf(bar!, "padding-left")).toBe(`${SHELL_TITLE_BAND_LEAD_PX}px`);
    expect(appRegionOf(bar!)).toBe("drag");
    // ...and the band above the whole app is told to stand down.
    expect(topChromeHoldsLights()).toBe(true);

    mounted.unmount();
  });

  test("EVERY SLOT A ROUTE FILLS OPTS OUT OF THE DRAG", () => {
    /*
      The rule `docs/decisions/desktop.md` named as the thing this change
      needed: with the bar a drag region, a control inside it moves the window
      instead of activating unless it says otherwise. Asserted on the slots
      rather than on the stubs inside them, because that is where the guard
      lives — a route may put anything in these, and a guard on the contents
      would hold only for the controls somebody remembered.
    */
    installMacShell();
    const mounted = mountFrame(1400);

    for (const testId of ["switcher", "tabs", "trailing"]) {
      const stub = mounted.find(testId);
      expect(stub).not.toBeNull();
      const slot = stub!.parentElement as HTMLElement;
      expect(appRegionOf(slot)).toBe("no-drag");
    }

    mounted.unmount();
  });

  test("...and what is left over is still the window's handle", () => {
    // The bar's own background — the gaps between slots and the air above the
    // tabs, which hang from its foot — is what a person grabs. If the bar
    // itself ever stopped being `drag`, the top edge would be dead.
    installMacShell();
    const mounted = mountFrame(1400);
    expect(appRegionOf(mounted.find("app-top-bar")!)).toBe("drag");
    mounted.unmount();
  });

  test("a Mac shell at compact: the phone bar refuses the job, and says so", () => {
    /*
      `topBarCompact` is absolute, transparent and lying over the note. A
      console window narrowed past `narrowBreakpoint` is this layout on a Mac,
      so the band above the app has to come back — and it only can if the
      frame stops claiming it.
    */
    installMacShell();
    const mounted = mountFrame(390);

    const bar = mounted.find("app-top-bar");
    expect(styleOf(bar!, "padding-left")).not.toBe(`${SHELL_TITLE_BAND_LEAD_PX}px`);
    expect(appRegionOf(bar!)).toBeNull();
    expect(topChromeHoldsLights()).toBe(false);

    mounted.unmount();
  });

  test("NARROWING A SHELL WINDOW HANDS THE JOB BACK, AND WIDENING TAKES IT AGAIN", () => {
    installMacShell();
    const mounted = mountFrame(1400);
    expect(topChromeHoldsLights()).toBe(true);

    mounted.resize(390);
    expect(topChromeHoldsLights()).toBe(false);
    expect(appRegionOf(mounted.find("app-top-bar")!)).toBeNull();

    mounted.resize(1400);
    expect(topChromeHoldsLights()).toBe(true);
    expect(styleOf(mounted.find("app-top-bar")!, "padding-left")).toBe(
      `${SHELL_TITLE_BAND_LEAD_PX}px`,
    );

    mounted.unmount();
  });

  test("the frame leaving gives the job back, so the next route gets its band", () => {
    installMacShell();
    const mounted = mountFrame(1400);
    expect(topChromeHoldsLights()).toBe(true);
    mounted.unmount();
    expect(topChromeHoldsLights()).toBe(false);
  });

  test("AN ORDINARY BROWSER TAB PAYS NOTHING — no lead, no drag region", () => {
    // There are no buttons to clear and no window to drag. 84pt of leading
    // inset here would be 84pt of nothing, on every desktop browser.
    removeShell();
    const mounted = mountFrame(1400);

    const bar = mounted.find("app-top-bar");
    expect(styleOf(bar!, "padding-left")).not.toBe(`${SHELL_TITLE_BAND_LEAD_PX}px`);
    expect(appRegionOf(bar!)).toBeNull();
    expect(topChromeHoldsLights()).toBe(false);

    mounted.unmount();
  });
});

/**
 * THE RIGHT PANEL, ON THE GLASS.
 *
 * `appFrame.test.ts` pins which arm of `Regions.aside` each density answers.
 * This is the half that file explicitly defers to here, plus the two claims
 * that are only true of a rendered tree:
 *
 *  - **the scrim does not cover the file tree.** `Regions.scrim` is one
 *    boolean and cannot say what it lies over, so the region sweep states the
 *    rule as "a column is never the panel a scrim is dismissing" and leaves
 *    "and is not covered by it" to this file. At `medium` the panel is over
 *    the note while the tree keeps its column, and a full-body scrim would
 *    grey out and make inert the region somebody reaches for to leave;
 *  - **the control and the region agree.** A toggle drawn where the command is
 *    a no-op, or a panel with no way to open it, is the pair `frame.ts` spends
 *    a section keeping honest, and neither is visible in a pure function.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. The scrim's `left` offset removed, so it covers the body.
 *     → **1 fails**: `the scrim spares the file tree beside it`.
 *  2. `asideToggle` dropped to `asideToggleFor(density) !== null`, ignoring
 *     whether a panel was supplied.
 *     → **1 fails**: `a surface with no panel is offered no way to open one`.
 *  3. `toggleAside` written without its `asideToggleFor` guard, so a press at
 *     compact writes `asideOpen`.
 *     → **1 fails**: `pressing at a phone width opens nothing, then or later`.
 *
 *     The test had to grow its second half before this sabotage could fail it,
 *     and that is the finding rather than a detail. Asserting only that the
 *     panel is absent at compact passes with the guard gone — `regionsFor`
 *     refuses to *draw* one there whatever the preference says — so the
 *     written state was wrong and invisible, surfacing on the next resize.
 *     Which is the ⌘B failure exactly: a command writing a field the layout it
 *     was pressed on never reads.
 */
describe("the right panel", () => {
  test("a desktop opens it beside the note", () => {
    const frame = mountFrame(1440);
    expect(frame.find("aside")).toBeNull();

    frame.press("frame-aside-toggle");

    expect(frame.find("aside")).not.toBeNull();
    // Beside, not over: no scrim, and the tree is still there.
    expect(frame.find("frame-scrim")).toBeNull();
    expect(frame.find("explorer")).not.toBeNull();
    frame.unmount();
  });

  test("a tablet opens it over the note, behind a scrim", () => {
    const frame = mountFrame(1000);
    frame.press("frame-aside-toggle");

    expect(frame.find("aside")).not.toBeNull();
    expect(frame.find("frame-scrim")).not.toBeNull();
    frame.unmount();
  });

  /**
   * The drawing fact `appFrame.test.ts` defers to this file.
   *
   * The scrim starts where the editor does. Asserted through the injected
   * stylesheet rather than by eye, because jsdom lays nothing out: the style
   * react-native-web resolves for the scrim carries the offset or it does not.
   */
  test("the scrim spares the file tree beside it", () => {
    const frame = mountFrame(1000);
    frame.press("frame-aside-toggle");

    const scrim = frame.find("frame-scrim");
    expect(scrim).not.toBeNull();
    const left = window.getComputedStyle(scrim!).left;
    // The tree's own width, so everything left of it is untouched.
    expect(left).toBe(`${layout.explorerWidth}px`);
    frame.unmount();
  });

  test("and covers everything when there is no tree to spare", () => {
    const frame = mountFrame(1000, "the note", { explorer: false });
    frame.press("frame-aside-toggle");

    const scrim = frame.find("frame-scrim");
    expect(scrim).not.toBeNull();
    expect(window.getComputedStyle(scrim!).left).toBe("0px");
    frame.unmount();
  });

  test("a phone draws no panel and offers no control", () => {
    const frame = mountFrame(390);
    expect(frame.find("frame-aside-toggle")).toBeNull();
    expect(frame.find("aside")).toBeNull();
    frame.unmount();
  });

  /**
   * The command is a genuine no-op at compact, not merely unreachable.
   *
   * There is no button in the chrome, so the only way to press it is the probe
   * — and that is the point: a chord or a console could reach the frame API,
   * and a `toggleAside` that wrote the preference anyway would leave the panel
   * open the moment somebody widened the window, with nothing on the phone
   * having said so.
   */
  test("pressing at a phone width opens nothing, then or later", () => {
    const frame = mountFrame(390, createElement(TogglesProbe));
    frame.press("probe-toggle-aside");
    expect(frame.find("aside")).toBeNull();

    // The half the compact assertion cannot see: widen it, and the panel is
    // still shut, because nothing was written.
    frame.resize(1440);
    expect(frame.find("aside")).toBeNull();
    frame.unmount();
  });

  test("a surface with no panel is offered no way to open one", () => {
    const frame = mountFrame(1440, "the note", { aside: false });
    expect(frame.find("frame-aside-toggle")).toBeNull();
    expect(frame.find("aside")).toBeNull();
    frame.unmount();
  });

  test("closing it puts it away again", () => {
    const frame = mountFrame(1440);
    frame.press("frame-aside-toggle");
    expect(frame.find("aside")).not.toBeNull();

    frame.press("frame-aside-toggle");
    expect(frame.find("aside")).toBeNull();
    frame.unmount();
  });

  /**
   * A preference, so it survives the window changing shape — which is the
   * whole reason `asideOpen` is not cleared by `panelsClearedFor`. What it
   * *draws* as changes with the density; that it is open does not.
   */
  test("it is still open after the window changes shape", () => {
    const frame = mountFrame(1440);
    frame.press("frame-aside-toggle");
    expect(frame.find("frame-scrim")).toBeNull();

    frame.resize(1000);
    expect(frame.find("aside")).not.toBeNull();
    expect(frame.find("frame-scrim")).not.toBeNull();

    frame.resize(1440);
    expect(frame.find("aside")).not.toBeNull();
    expect(frame.find("frame-scrim")).toBeNull();
    frame.unmount();
  });

  test("pressing the scrim closes it", () => {
    const frame = mountFrame(1000);
    frame.press("frame-aside-toggle");
    expect(frame.find("aside")).not.toBeNull();

    frame.press("frame-scrim");
    expect(frame.find("aside")).toBeNull();
    frame.unmount();
  });

  /**
   * A column is resizable and an overlay is not, and that is not an oversight.
   * The overlay is pinned to the trailing edge over the note, so dragging its
   * edge would resize a thing that is already covering the thing it would be
   * making room in.
   */
  test("the column has a drag handle and the overlay does not", () => {
    const wide = mountFrame(1440);
    wide.press("frame-aside-toggle");
    expect(wide.find("aside-resizer")).not.toBeNull();
    wide.unmount();

    const tablet = mountFrame(1000);
    tablet.press("frame-aside-toggle");
    expect(tablet.find("aside-resizer")).toBeNull();
    tablet.unmount();
  });
});
