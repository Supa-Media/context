/**
 * @jest-environment jsdom
 */

/**
 * THE ONLY CONSOLE ANYBODY CAN OPEN IN A BROWSER, AT BOTH DENSITIES.
 *
 * `/e2e-fixture` is the single browser-reachable console in this repository —
 * every other route wants a session and a deployment — so it is what the
 * WebKit suite drives, what a screenshot of "the console" is taken against,
 * and what anybody looking at this product in a real browser is looking at.
 *
 * It was the phone console at every width. `E2EFixtureScreen` wires
 * `BrowsePane` under a `NavBandProvider` exactly as `app/(app)/console/_layout`
 * does, and `BrowsePane` draws that band **at compact only** — the pointer
 * layouts have the rail instead, which this screen did not mount. So at
 * 1440×900 the fixture had no context switcher at all: measured in Chromium,
 * the whole console answered three `[role=button]` elements — an avatar, one
 * breadcrumb crumb and the save pill — while the same fixture at 390×844 drew
 * `@lk` and `@public-worship` above the path.
 *
 * **That is a hole in the fixture and not in the product** — `ConsoleRail` has
 * carried the contexts at medium and wide the whole time, and
 * `consoleChrome.test.ts` now asserts it at both densities against the real
 * layout. What was missing is that nothing said the browser-reachable console
 * had to be the same application: a fixture that quietly drops a region is a
 * fixture that reports a defect the product does not have, and hides one it
 * does.
 *
 * So this file asks the fixture the one question its own header now answers:
 * at every density, is the set of contexts a person can reach on the screen?
 *
 * SABOTAGE: drop the rail column from `E2EFixtureScreen` and "a pointer layout
 * reaches every context" fails; gate `NavBandProvider`'s `contexts` on the
 * pointer branch instead and "a phone reaches every context" fails.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));

/*
  `BrowsePane` instantiates its own passphrase controller, which calls
  `useAction`. Nothing here exercises encryption, so a stub that refuses if it
  is ever actually called is enough to let the pane mount — the same bargain
  `noteChrome.test.ts` makes, for the same reason.
*/
jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
}));

const { E2EFixtureScreen } =
  require("../features/console/E2EFixtureScreen") as typeof import("../features/console/E2EFixtureScreen");
const { ThemeProvider } =
  require("../features/design/theme") as typeof import("../features/design/theme");

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!();
});

/** The fixture's three contexts — `placeholderData.ts`'s demo workspaces. */
const CONTEXTS = ["@seyi", "@lk", "@public-worship"];

function mountFixture(width: number) {
  // react-native-web measures `document.documentElement.clientWidth`, which
  // jsdom reports as 0. See `appFrameRender.test.ts` for the full trap.
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(
      createElement(ThemeProvider, {
        scheme: "dark",
        children: createElement(E2EFixtureScreen),
      }),
    );
  });
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** Every context named by something that can be pressed, wherever it is. */
  const reachable = () => {
    const labels = Array.from(container.querySelectorAll('[role="button"]')).map(
      (node) => `${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""}`,
    );
    /*
      The `@` is part of the match on purpose. A bare slug is a substring of
      plenty of ordinary prose — a note called "Talk to @lk" would make this
      pass with no switcher anywhere on the screen — and `atName` puts the `@`
      on every label either surface draws.
    */
    return CONTEXTS.filter((name) => labels.some((label) => label.includes(name)));
  };

  return { container, reachable };
}

/* -------------------------------------------------------------------------- */

describe("the browser-reachable console offers its contexts at every density", () => {
  test("a phone reaches every context", () => {
    // The control: this is what was already true, and what made the pointer
    // layout's silence look like a rendering quirk rather than a missing
    // region.
    expect(mountFixture(390).reachable()).toEqual(CONTEXTS);
  });

  test("a pointer layout reaches every context", () => {
    expect(mountFixture(1440).reachable()).toEqual(CONTEXTS);
  });

  test("a tablet reaches every context, where the rail is only its marks", () => {
    /*
      `medium` collapses the rail to icons, which is exactly the presentation
      that has no visible text — so the accessible name is the whole of what a
      person or a screen reader has, and `ConsoleRail`'s own rule ("a rail that
      becomes a row of unlabelled glyphs to a screen reader is not collapsed,
      it is broken") is what this checks is still true here.
    */
    expect(mountFixture(1000).reachable()).toEqual(CONTEXTS);
  });

  test("and never draws two switchers at once", () => {
    /*
      `frame.ts` is explicit that the strip and the rail are never on one
      screen: the strip's dot means *kind* and the rail's means *storage
      status*, and one glyph with two meanings on one screen is worse than
      either. The fixture is the screen where that would happen first, because
      it is the one that supplies both.
    */
    const desktop = mountFixture(1440);
    expect(desktop.container.querySelectorAll('[data-testid="context-strip"]')).toHaveLength(0);
    expect(desktop.container.querySelectorAll('[data-testid="console-rail"]')).toHaveLength(1);

    const phone = mountFixture(390);
    expect(phone.container.querySelectorAll('[data-testid="context-strip"]')).toHaveLength(1);
    expect(phone.container.querySelectorAll('[data-testid="console-rail"]')).toHaveLength(0);
  });
});
