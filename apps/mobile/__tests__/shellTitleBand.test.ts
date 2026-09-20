/**
 * @jest-environment jsdom
 */

/**
 * THE CONSOLE RESERVES THE SPACE FOR THE SHELL'S TRAFFIC LIGHTS.
 *
 * `docs/decisions/desktop.md`, "The console reserves the space", and the
 * orchestrator's decision it records (2026-09-07): the desktop shell's console
 * window is frameless with inset traffic lights, and the hosted page used to
 * draw from `x: 0` — so the close/minimise/zoom buttons sat on top of the
 * console's own top-left content (the active-context chip). The fix is a band
 * only a Mac inside the shell gets: 38px, full width, in the console's own
 * header colour, draggable so the window can still be moved by it.
 *
 * Two files, two kinds of check:
 *
 *  - `shellTitleBand.ts` is the rule, as a pure function of two strings — see
 *    its own header for why it takes `platformOS` and `shellPlatform` rather
 *    than reading `Platform.OS` and a bridge itself.
 *  - `ShellTitleBand.tsx` is the component that reads those two globals and
 *    draws (or does not draw) the strip. Rendered here with the reference fake
 *    shell from `@context/desktop-bridge/fake`, exactly as
 *    `meetingsDesktop.test.ts` does, so a bridge shaped like a real one is
 *    what this suite exercises rather than a hand-rolled guess.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   `shouldShowShellTitleBand` returning `true` for any shell           2
 *   ...dropping the `platformOS !== "web"` guard                        1
 *   `ShellTitleBand` reading `bridge.shell.platform` without `?.`        1
 *   the band's height hard-coded instead of `SHELL_TITLE_BAND_PX`       1
 *   the band losing `WebkitAppRegion: "drag"`                          1
 *   `viewportHeight` ignoring its inset (the clipped footer)             1
 *   `shellTitleBandPx` answering the band's height with no shell         2
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { fakeDesktopBridge } from "@context/desktop-bridge/fake";
import { SHELL_TITLE_BAND_LEAD_PX, SHELL_TITLE_BAND_PX } from "@context/desktop-bridge";
import {
  shellBandDraws,
  shellLightsLeadPx,
  shellTitleBandPx,
  shouldShowShellTitleBand,
} from "../features/app/shellTitleBand";
import {
  RootShellTitleBand,
  ShellTitleBand,
  useShellBandAbovePx,
  useShellLightsLeadPx,
  useShellTitleBandPx,
} from "../features/app/ShellTitleBandView";
import { setTopChromeHoldsLights } from "../features/app/topChrome";

/** Stands in for a mounted frame — see `topChrome.ts` on why claims are keyed. */
const CLAIM = "shell-title-band-test";
import { layout } from "../features/design/tokens";
import { viewportHeight } from "../features/design/css";
// `StyleSheet.getSheet()` is react-native-web's, absent from the `react-native`
// types this repo compiles against — see `design-shots.ts`'s own note on it.
const { StyleSheet: RNStyleSheet } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */
/* the pure rule                                                              */
/* -------------------------------------------------------------------------- */

describe("shouldShowShellTitleBand", () => {
  test("web, inside a Mac shell: the band shows", () => {
    expect(shouldShowShellTitleBand("web", "macos")).toBe(true);
  });

  test("web, inside a non-mac shell: no band", () => {
    expect(shouldShowShellTitleBand("web", "windows")).toBe(false);
    expect(shouldShowShellTitleBand("web", "linux")).toBe(false);
  });

  test("web, no shell at all: no band", () => {
    expect(shouldShowShellTitleBand("web", null)).toBe(false);
    expect(shouldShowShellTitleBand("web", undefined)).toBe(false);
  });

  test("not web — a phone can never be inside the shell, mac shell or not", () => {
    expect(shouldShowShellTitleBand("ios", "macos")).toBe(false);
    expect(shouldShowShellTitleBand("android", "macos")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* the component, against the reference fake shell                           */
/* -------------------------------------------------------------------------- */

/** Put a shell on the page, the way a preload would. Same helper as `meetingsDesktop.test.ts`. */
function installShell(bridge: unknown): void {
  (globalThis as Record<string, unknown>).desktop = bridge;
}

function removeShell(): void {
  delete (globalThis as Record<string, unknown>).desktop;
}

function mount(element: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  return {
    container: host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const band = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="shell-title-band"]');

beforeEach(() => {
  document.body.replaceChildren();
  removeShell();
  setTopChromeHoldsLights(CLAIM, false);
});

afterEach(() => {
  removeShell();
  setTopChromeHoldsLights(CLAIM, false);
});

/** A Mac inside the shell, which is the only configuration with buttons. */
function installMacShell(): void {
  installShell(
    fakeDesktopBridge({ shell: { app: "Context", version: "1.0.0", platform: "macos" } }).bridge,
  );
}

describe("ShellTitleBand", () => {
  test("a Mac shell: the band renders, full width, at the shared height", () => {
    installShell(fakeDesktopBridge({ shell: { app: "Context", version: "1.0.0", platform: "macos" } }).bridge);

    const mounted = mount(createElement(ShellTitleBand));
    const node = band(mounted.container);
    expect(node).not.toBeNull();
    // react-native-web renders styles as atomic CSS classes rather than an
    // inline `style` attribute, so the applied value is read the way every
    // other render test in this suite reads one — `getComputedStyle`, never
    // `node.style` (see `appFrameRender.test.ts`'s own note on this). This is
    // the one property that must never drift from the shared constant both
    // processes import.
    const computed = window.getComputedStyle(node!);
    expect(computed.height).toBe(`${SHELL_TITLE_BAND_PX}px`);
    expect(computed.width).toBe("100%");
    mounted.unmount();
  });

  test("a non-mac shell: no band", () => {
    installShell(
      fakeDesktopBridge({ shell: { app: "Context", version: "1.0.0", platform: "windows" } }).bridge,
    );

    const mounted = mount(createElement(ShellTitleBand));
    expect(band(mounted.container)).toBeNull();
    mounted.unmount();
  });

  test("no shell at all — an ordinary browser tab: no band", () => {
    removeShell();

    const mounted = mount(createElement(ShellTitleBand));
    expect(band(mounted.container)).toBeNull();
    mounted.unmount();
  });

  test("the band is draggable, so the window can still be moved by it", () => {
    installShell(fakeDesktopBridge({ shell: { app: "Context", version: "1.0.0", platform: "macos" } }).bridge);

    const mounted = mount(createElement(ShellTitleBand));
    const node = band(mounted.container);
    /*
      Not `getComputedStyle`. `-webkit-app-region` is not a property jsdom's
      CSS engine knows, so it drops the declaration from the CSSOM entirely
      and every computed-style read comes back `""` whether the rule is there
      or not — the same failure mode `design-shots.ts` documents for `dvh`.
      react-native-web's atomic class names encode the *style key* it was
      given rather than the CSS it produces, so the presence of the class is
      the same check `contextStrip.test.ts` and `navBand.test.ts` use for
      another property CSS.supports would also refuse in jsdom
      (`backgroundImage`'s gradient syntax) — see the sheet dump this was
      written against: `.r-WebkitAppRegion-<hash>{-webkit-app-region:drag;}`.
    */
    expect(node?.className).toContain("r-WebkitAppRegion");
    // And the value, not only that the property was set to *something* —
    // read straight out of the injected sheet, which is the only place in
    // this environment that still has it.
    expect(RNStyleSheet.getSheet().textContent).toMatch(/-webkit-app-region:\s*drag;/);
    mounted.unmount();
  });
});

/* -------------------------------------------------------------------------- */
/* the same reservation as a number — what the frame and the overlays pay      */
/* -------------------------------------------------------------------------- */

/**
 * THE BOTTOM OF THE CONSOLE WAS OFF THE BOTTOM OF THE WINDOW.
 *
 * Reported against the shipped shell: *"the bottom part looks cut off"*. The
 * band reserves 38px at the top, and `AppFrame` is sized in viewport units
 * rather than by a flex parent — so a full `100dvh` frame drawn under a 38px
 * band is a window-and-a-bit tall, and the last 38px of it, which is where the
 * context switcher and the sync row sit, had nowhere to go and no way to
 * scroll to it.
 */
describe("the band's height, as the number the rest of the app pays", () => {
  test("a Mac shell reserves the shared constant; nothing else reserves anything", () => {
    expect(shellTitleBandPx("web", "macos", SHELL_TITLE_BAND_PX)).toBe(SHELL_TITLE_BAND_PX);
    expect(shellTitleBandPx("web", "windows", SHELL_TITLE_BAND_PX)).toBe(0);
    expect(shellTitleBandPx("web", null, SHELL_TITLE_BAND_PX)).toBe(0);
    expect(shellTitleBandPx("ios", "macos", SHELL_TITLE_BAND_PX)).toBe(0);
  });

  test("the hook answers the same, from the bridge on the page", () => {
    installShell(
      fakeDesktopBridge({ shell: { app: "Context", version: "1.0.0", platform: "macos" } }).bridge,
    );
    expect(readBandPx()).toBe(SHELL_TITLE_BAND_PX);

    removeShell();
    expect(readBandPx()).toBe(0);
  });

  test("THE FRAME IS ONE VIEWPORT MINUS THE BAND, never a whole one under it", () => {
    // Asserted against the style function rather than a rendered node for the
    // reason `appFrameRender.test.ts` gives: jsdom's CSS parser knows neither
    // `dvh` nor `calc` with it, and drops the declaration either way.
    expect(viewportHeight(SHELL_TITLE_BAND_PX)).toMatchObject({
      height: `calc(100dvh - ${SHELL_TITLE_BAND_PX}px)`,
      maxHeight: `calc(100dvh - ${SHELL_TITLE_BAND_PX}px)`,
    });
  });

  test("...and an ordinary browser tab is still exactly one viewport", () => {
    expect(viewportHeight(0)).toMatchObject({ height: "100dvh", maxHeight: "100dvh" });
    expect(viewportHeight()).toMatchObject({ height: "100dvh", maxHeight: "100dvh" });
  });
});

/** `useShellTitleBandPx` read out of a mounted probe, the way a component sees it. */
function readBandPx(): number {
  let seen: number | null = null;
  function Probe() {
    seen = useShellTitleBandPx();
    return null;
  }
  const mounted = mount(createElement(Probe));
  mounted.unmount();
  if (seen === null) throw new Error("the probe never rendered");
  return seen;
}


/* -------------------------------------------------------------------------- */
/* the band moves into the bar                                                */
/* -------------------------------------------------------------------------- */

/**
 * THE BAND WAS AN EMPTY STRIP ON TOP OF A BAR THE SAME HEIGHT.
 *
 * `docs/decisions/desktop.md`, "The band moves into the bar", and the paragraph
 * the change before it left behind: *"the band is still an empty strip above
 * the console's own top bar, where a Mac app people compare this to puts the
 * lights in that bar"*. 45pt of reservation over 45pt of chrome is 90pt before
 * the first note, half of it drawing nothing.
 *
 * The fix is a handshake rather than a constant, because only some routes have
 * a bar that can take the job — `topChrome.ts` is the argument. These are the
 * two halves of it that are pure rules, and the component split that keeps the
 * settings overlay out of it.
 */
describe("shellBandDraws — the root band stands down for chrome that took the job", () => {
  test("a Mac shell, nothing holding them: the band draws, as before", () => {
    expect(shellBandDraws("web", "macos", false)).toBe(true);
  });

  test("a Mac shell, the bar holding them: no band", () => {
    expect(shellBandDraws("web", "macos", true)).toBe(false);
  });

  test("THE FLAG MAY ONLY EVER TAKE A BAND AWAY, NEVER ADD ONE", () => {
    /*
      The platform gate is asked first and the flag second, which is the only
      safe order: a frame publishing "I hold them" is stating its own opinion
      about a shell it may not be inside, and a route that said `false` on
      Windows must not be able to conjure a band onto a window with no buttons
      on it. Reverse the two and every non-mac surface grows 45pt of nothing
      the moment a frame unmounts.
    */
    expect(shellBandDraws("web", "windows", false)).toBe(false);
    expect(shellBandDraws("web", "linux", false)).toBe(false);
    expect(shellBandDraws("web", null, false)).toBe(false);
    expect(shellBandDraws("ios", "macos", false)).toBe(false);
    expect(shellBandDraws("android", null, false)).toBe(false);
  });
});

describe("shellLightsLeadPx — what a bar holding them owes at its leading edge", () => {
  test("a Mac shell, and this bar took the job: the shared lead", () => {
    expect(shellLightsLeadPx("web", "macos", true, SHELL_TITLE_BAND_LEAD_PX)).toBe(
      SHELL_TITLE_BAND_LEAD_PX,
    );
  });

  test("a Mac shell, but the band still has it: nothing", () => {
    expect(shellLightsLeadPx("web", "macos", false, SHELL_TITLE_BAND_LEAD_PX)).toBe(0);
  });

  test("NO SHELL, NO LEAD — 84pt of nothing in an ordinary browser tab", () => {
    expect(shellLightsLeadPx("web", "windows", true, SHELL_TITLE_BAND_LEAD_PX)).toBe(0);
    expect(shellLightsLeadPx("web", null, true, SHELL_TITLE_BAND_LEAD_PX)).toBe(0);
    expect(shellLightsLeadPx("ios", "macos", true, SHELL_TITLE_BAND_LEAD_PX)).toBe(0);
  });
});

describe("RootShellTitleBand, and the overlay that must not copy it", () => {
  test("nothing holds the lights: the root band draws", () => {
    installMacShell();
    const mounted = mount(createElement(RootShellTitleBand));
    expect(band(mounted.container)).not.toBeNull();
    mounted.unmount();
  });

  test("the console bar holds them: the root band is gone", () => {
    installMacShell();
    setTopChromeHoldsLights(CLAIM, true);
    const mounted = mount(createElement(RootShellTitleBand));
    expect(band(mounted.container)).toBeNull();
    mounted.unmount();
  });

  test("SETTINGS KEEPS ITS OWN BAND WHILE THE CONSOLE BEHIND IT HOLDS THE LIGHTS", () => {
    /*
      The regression this split exists for. `Overlay` is a `Modal` — its own
      root view, with nothing in the route tree above it — and the console
      frame *behind* it goes on publishing "I hold them" for as long as
      settings is open. An overlay that read the flag would stand its own band
      down and put the buttons back over its own first control, which is the
      defect `docs/decisions/desktop.md` records under "The band's other two
      payers" and the owner reported as *"some pages dont take the streetlights
      in consideration"*.

      So `ShellTitleBand` is unconditional and `RootShellTitleBand` is the only
      reader of the store — asserted here as the same flag giving two different
      answers to the two components.
    */
    installMacShell();
    setTopChromeHoldsLights(CLAIM, true);

    const overlay = mount(createElement(ShellTitleBand));
    expect(band(overlay.container)).not.toBeNull();
    overlay.unmount();

    const root = mount(createElement(RootShellTitleBand));
    expect(band(root.container)).toBeNull();
    root.unmount();
  });
});

describe("the two hooks the frame reads", () => {
  test("a frame holding the lights has nothing above it and is a whole viewport", () => {
    installMacShell();
    expect(readHook(() => useShellBandAbovePx(true))).toBe(0);
    expect(readHook(() => useShellBandAbovePx(false))).toBe(SHELL_TITLE_BAND_PX);
  });

  test("the lead follows the same rule, from the bridge on the page", () => {
    installMacShell();
    expect(readHook(() => useShellLightsLeadPx(true))).toBe(SHELL_TITLE_BAND_LEAD_PX);
    expect(readHook(() => useShellLightsLeadPx(false))).toBe(0);

    removeShell();
    expect(readHook(() => useShellLightsLeadPx(true))).toBe(0);
  });
});

/**
 * THE EQUALITY THAT MAKES ANY OF THIS POSSIBLE.
 *
 * `trafficLightPosition` is set once, when the window is created, and the
 * page's density goes on changing under it — so the band and the bar cannot be
 * two different heights with one `y` centring the buttons in both. They are
 * the same height, and this is the assertion from the app's side; the
 * package's own suite makes the other half, that `SHELL_TRAFFIC_LIGHTS.y`
 * centres a button in it.
 */
describe("the band's height is the top bar's height", () => {
  test("one box, whichever of the two draws it", () => {
    expect(SHELL_TITLE_BAND_PX).toBe(layout.topBarHeight);
  });

  test("the lead clears the buttons with room for the chip after them", () => {
    expect(SHELL_TITLE_BAND_LEAD_PX).toBeGreaterThan(SHELL_TITLE_BAND_PX);
  });
});

/** Read any hook out of a mounted probe, the way a component sees it. */
function readHook<T>(read: () => T): T {
  let seen: { value: T } | null = null;
  function Probe() {
    seen = { value: read() };
    return null;
  }
  const mounted = mount(createElement(Probe));
  mounted.unmount();
  if (seen === null) throw new Error("the probe never rendered");
  return (seen as { value: T }).value;
}
