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
// These layout fixtures have no authenticated gateway session.
jest.mock("../features/agent/useConsoleGrant", () => ({
  useConsoleGrant: () => async () => { throw new Error("No fixture gateway session"); },
}));

jest.mock("convex/react", () => ({
  // An owner picker searches through the client; nothing here opens one.
  useConvex: () => ({ query: async () => undefined }),
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

  /*
    Open the workspace switcher, if this density has one.

    A phone's contexts are `NavBand`'s, in the scroller, and are on the screen
    from the first frame. A pointer layout's are `SwitcherMenu`'s, behind the
    name in the title bar — so reaching them is a press, which is what a person
    does too. Pressing nothing when there is no trigger is how the phone's case
    stays the control it was written to be.
  */
  const openSwitcher = () => {
    const trigger = document.body.querySelector<HTMLElement>('[data-testid="frame-switcher"]');
    if (trigger === null) return;
    act(() => {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  /** Every context named by something that can be pressed, wherever it is. */
  const reachable = () => {
    openSwitcher();
    /*
      `document.body`, not the container: react-native-web renders a `Menu`
      through a portal, so the switcher's rows land outside the tree they were
      declared in.
    */
    const labels = Array.from(
      /*
        Both roles, because the two surfaces are two kinds of control. The
        phone's contexts are buttons in `NavBand`; the pointer layout's are
        rows in a `Menu`, which announces itself as a menu and its rows as
        `menuitem`. Asking for `button` alone found the switcher's own trigger
        and none of the workspaces behind it.
      */
      document.body.querySelectorAll('[role="button"], [role="menuitem"]'),
    ).map((node) => `${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""}`);
    /*
      The `@` is part of the match on purpose. A bare slug is a substring of
      plenty of ordinary prose — a note called "Talk to @lk" would make this
      pass with no switcher anywhere on the screen — and `atName` puts the `@`
      on every label either surface draws.
    */
    return CONTEXTS.filter((name) => labels.some((label) => label.includes(name)));
  };

  return { container, reachable, openSwitcher };
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

  test("a tablet reaches every context, from the same one control", () => {
    /*
      `medium` used to collapse the rail to its icons, which was the one
      presentation with no visible text — so the accessible name was all a
      person or a screen reader had, and that is what this checked. There is no
      icon rail any more: `SwitcherMenu` is one control drawn the same way at
      both pointer densities, and its rows carry their labels as text.
    */
    expect(mountFixture(1000).reachable()).toEqual(CONTEXTS);
  });

  test("and never draws two switchers at once", () => {
    /*
      `frame.ts` is explicit that the strip and the title bar's switcher are
      never on one screen: the strip's dot means *kind* and the switcher's
      means *storage status*, and one glyph with two meanings on one screen is
      worse than either. The fixture is the screen where that would happen
      first, because it is the one that supplies both.
    */
    const desktop = mountFixture(1440);
    expect(desktop.container.querySelectorAll('[data-testid="context-strip"]')).toHaveLength(0);
    expect(desktop.container.querySelectorAll('[data-testid="frame-switcher"]')).toHaveLength(1);

    const phone = mountFixture(390);
    expect(phone.container.querySelectorAll('[data-testid="context-strip"]')).toHaveLength(1);
    expect(phone.container.querySelectorAll('[data-testid="frame-switcher"]')).toHaveLength(0);
  });
});
