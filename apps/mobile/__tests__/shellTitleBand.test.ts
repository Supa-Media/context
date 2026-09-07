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
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { fakeDesktopBridge } from "@context/desktop-bridge/fake";
import { SHELL_TITLE_BAND_PX } from "@context/desktop-bridge";
import { shouldShowShellTitleBand } from "../features/app/shellTitleBand";
import { ShellTitleBand } from "../features/app/ShellTitleBand";
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
});

afterEach(() => {
  removeShell();
});

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
