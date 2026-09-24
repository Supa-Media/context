/**
 * @jest-environment jsdom
 */

import { jest } from "@jest/globals";
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
 *
 * This module is the shared mounting harness for every file in this folder —
 * it carries no tests of its own. `jest.mock` is per test file, so every file
 * here re-registers it; it happens once more, here, so the `require()`s below
 * (of `AppFrame` and friends) resolve against the mock rather than the real
 * `react-native-safe-area-context`.
 */

// `mock`-prefixed so `jest.mock`'s hoisted factory may close over it.
export const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };

// The frame reads the notch and the home indicator. A provider would be a
// second thing under test; the insets themselves are the platform's business,
// not this component's.
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

// Imported after the mock, which `jest.mock` hoists above it anyway.
const { AppFrame, useFrame } =
  require("../../features/app/AppFrame") as typeof import("../../features/app/AppFrame");
const { layout } = require("../../features/design/tokens") as typeof import("../../features/design/tokens");
const { bottomChromeHeight } =
  require("../../features/app/bottomChrome") as typeof import("../../features/app/bottomChrome");
const { viewportHeight } = require("../../features/design/css") as typeof import("../../features/design/css");
const { topChromeHoldsLights, setTopChromeHoldsLights } =
  require("../../features/app/topChrome") as typeof import("../../features/app/topChrome");
const { SHELL_TITLE_BAND_LEAD_PX } =
  require("@context/desktop-bridge") as typeof import("@context/desktop-bridge");
const { fakeDesktopBridge } =
  require("@context/desktop-bridge/fake") as typeof import("@context/desktop-bridge/fake");
// `StyleSheet.getSheet()` is react-native-web's, absent from the `react-native`
// types this repo compiles against — the same read `shellTitleBand.test.ts`
// documents, and for the same reason: jsdom's CSS engine does not know
// `-webkit-app-region`, drops the declaration from the CSSOM, and answers `""`
// to every computed-style read of it whether the rule is there or not.
const { StyleSheet: RNStyleSheet } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
};

export {
  AppFrame,
  useFrame,
  layout,
  bottomChromeHeight,
  viewportHeight,
  topChromeHoldsLights,
  setTopChromeHoldsLights,
  SHELL_TITLE_BAND_LEAD_PX,
  fakeDesktopBridge,
  RNStyleSheet,
};

/* -------------------------------------------------------------------------- */

export interface Mounted {
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
export function mountFrame(
  width: number,
  children: ReactNode = "the note",
  options: { explorer?: boolean; accountSlot?: boolean; aside?: boolean } = {},
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
        /*
          The right panel, supplied by default so the toggle exists in most
          cases and absent when a case is about a surface that has none — the
          landing page's picture of the console, the fixtures. `AppFrame` draws
          neither the panel nor its control when this is missing, which is the
          rule the `no panel supplied` case below holds it to.
        */
        aside:
          options.aside === false
            ? undefined
            : createElement("span", { "data-testid": "aside" }, "chat"),
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
export function styleOf(node: HTMLElement, property: string): string {
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
export function TogglesProbe() {
  const frame = useFrame();
  /*
    One button, and it used to be two.

    `frame.toggleRail` was the other, and it went with the rail: there is no
    column at any density now, so a probe for it would be a press with nothing
    to observe. What is left is the tree's, which is the command this file
    still has to prove harmless at compact.
  */
  return createElement("span", null, [
    createElement(
      "button",
      { key: "explorer", "data-testid": "probe-toggle-explorer", onClick: frame.toggleExplorer },
      "toggle the explorer",
    ),
    /*
      The right panel's, for the reason this probe exists at all: there is no
      control in the chrome that reaches it on a phone — `asideToggle` refuses
      to draw one — so a probe is the only way to press it at that density, and
      pressing it is exactly what has to be proven harmless. A command that
      wrote `asideOpen` where no layout reads it would be silently wrong until
      the window widened, which is the ⌘B failure `frame.ts` keeps a paragraph
      about.
    */
    createElement(
      "button",
      { key: "aside", "data-testid": "probe-toggle-aside", onClick: frame.toggleAside },
      "toggle the panel",
    ),
  ]);
}

/** Hover in and out of a node, which is how react-native-web reports `onHoverIn`. */
export function hover(node: HTMLElement) {
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
export function FocusProbe() {
  const frame = useFrame();
  return createElement(
    "button",
    { "data-testid": "probe-toggle-focus", onClick: frame.toggleFocus },
    "toggle focus",
  );
}

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
export function pointerOn(node: HTMLElement) {
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

/**
 * Which `-webkit-app-region` react-native-web actually gave this node, read
 * out of the injected sheet.
 *
 * Its class names encode the style *key* and a hash of the value, so `drag`
 * and `no-drag` both produce `r-WebkitAppRegion-<something>` and the prefix
 * alone cannot tell them apart — which is the whole assertion here. The class
 * on the node is looked up in the sheet and the declared value returned.
 */
export function appRegionOf(node: HTMLElement): string | null {
  const sheet = RNStyleSheet.getSheet().textContent;
  for (const cls of Array.from(node.classList)) {
    if (!cls.startsWith("r-WebkitAppRegion")) continue;
    const found = sheet.match(new RegExp(`\\.${cls}\\s*\\{[^}]*-webkit-app-region:\\s*([a-z-]+)`));
    if (found) return found[1];
  }
  return null;
}

export function installMacShell(): void {
  (globalThis as Record<string, unknown>).desktop = fakeDesktopBridge({
    shell: { app: "Context", version: "1.0.0", platform: "macos" },
  }).bridge;
}

export function removeShell(): void {
  delete (globalThis as Record<string, unknown>).desktop;
}

// `useEffect`/`useState` are re-exported for the probes that need them so that
// split test files do not have to import `react` a second time for one hook.
export { useEffect, useState, createElement };
export type { ReactNode };
