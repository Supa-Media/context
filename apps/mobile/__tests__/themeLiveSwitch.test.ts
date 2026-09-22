/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

/**
 * A change of appearance while the app is open reaches every component.
 *
 * It did not. Switching macOS between light and dark left some of the console
 * in the old palette until a reload: the active tab, the selected row in the
 * tree, the explorer's buttons, and the note's own ink, which is how a light
 * page ended up with near-white text on it.
 *
 * ## The mechanism, because it is not visible in any one file
 *
 * react-native-web's `useColorScheme` keeps its own `useState` per call and
 * re-subscribes to the media query in an effect with no dependency array, so
 * after every render it removes its listener and adds a new one. A browser
 * dispatches a `MediaQueryList` change to each listener in turn, with a
 * microtask checkpoint after each, and React treats a `change` event as
 * discrete: the first listener's `setState` is rendered and its effects
 * flushed before the second listener is called. That render re-subscribes
 * every hook in the component (and in everything below it), and a listener
 * removed mid-dispatch is skipped. So the first `useColorScheme` in a subtree
 * hears the change and every later one misses it — `useColors` and
 * `useThemedStyles` in one component could disagree for the rest of the
 * session.
 *
 * ## How this reproduces it
 *
 * The fake query below dispatches the way a browser does: over a snapshot of
 * the listeners, skipping any removed along the way, and flushing React after
 * each one (`act`), which stands in for the microtask checkpoint. It is
 * installed before react-native-web is loaded, because `Appearance` reads
 * `matchMedia` once at module scope.
 */

type Listener = (event: { matches: boolean }) => void;

class FakeQuery {
  matches = false;
  private listeners = new Set<Listener>();
  addListener(listener: Listener) {
    this.listeners.add(listener);
  }
  removeListener(listener: Listener) {
    this.listeners.delete(listener);
  }
  addEventListener(_type: string, listener: Listener) {
    this.addListener(listener);
  }
  removeEventListener(_type: string, listener: Listener) {
    this.removeListener(listener);
  }
  switchTo(scheme: "light" | "dark") {
    this.matches = scheme === "dark";
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      act(() => listener({ matches: this.matches }));
    }
  }
}

const query = new FakeQuery();
Object.defineProperty(window, "matchMedia", { configurable: true, value: () => query });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Required after `matchMedia` exists, which `import` would hoist above.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useColors, useScheme, useThemedStyles } = require("../features/design/theme") as typeof import("../features/design/theme");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { darkColors, lightColors } = require("../features/design/tokens") as typeof import("../features/design/tokens");

function mount(node: ReactNode): () => void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return () => {
    act(() => root.unmount());
    host.remove();
  };
}

const makeStyles = (colors: { surface2: string }) => ({
  button: { backgroundColor: colors.surface2 },
});

describe("a live change of appearance", () => {
  test("reaches every hook in every component, in both directions", () => {
    const seen: Record<string, unknown> = {};
    // The shape of `Explorer`'s `IconButton`: the palette and a stylesheet,
    // which are two reads of the scheme in one component.
    function Child() {
      seen.childColors = useColors();
      seen.childStyles = useThemedStyles(makeStyles).button.backgroundColor;
      return null;
    }
    function Parent() {
      seen.parentScheme = useScheme();
      return createElement(Child);
    }

    const unmount = mount(createElement(Parent));
    try {
      expect(seen).toEqual({
        parentScheme: "light",
        childColors: lightColors,
        childStyles: lightColors.surface2,
      });

      query.switchTo("dark");
      expect(seen).toEqual({
        parentScheme: "dark",
        childColors: darkColors,
        childStyles: darkColors.surface2,
      });

      query.switchTo("light");
      expect(seen).toEqual({
        parentScheme: "light",
        childColors: lightColors,
        childStyles: lightColors.surface2,
      });
    } finally {
      unmount();
    }
  });
});
