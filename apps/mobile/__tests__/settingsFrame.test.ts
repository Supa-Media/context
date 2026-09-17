/**
 * @jest-environment jsdom
 */

/**
 * SETTINGS IS A PAGE, NOT A CARD FLOATING OVER ONE.
 *
 * Reported from the shipped app, about this exact screen: *"the app looks
 * nothing like [the design] right now, the only thing changed was colours."*
 * The palette had landed and the composition had not, and the loudest part of
 * that is the chrome — a 940×660 panel with a 16px radius and a drop shadow,
 * centred on a 72%-black scrim, with the console greyed out behind it.
 *
 * ## What is *not* changing, and why this is not the old route coming back
 *
 * Settings stopped being a route for a reason that still holds: it rides in
 * the query beside `?note=`, so Browse stays mounted and the note keeps its
 * address, and closing drops one parameter instead of reconstructing where
 * somebody came from (`settingsClose.test.ts` carries that history). Every
 * word of that survives — `?settings=<section>` is still the address, the
 * layout still draws this over Browse, nothing is pushed and nothing is
 * replaced. What changes is that the surface **fills the window** instead of
 * hovering in the middle of it, which is a question about chrome and not
 * about routing.
 *
 * So the guarantees here are the ones a screenshot would catch and jsdom
 * otherwise cannot:
 *
 *  - no scrim, because nothing is behind this to look at;
 *  - no rounded, capped, shadowed card — the page is the width of the window;
 *  - the way out is named. A bare `×` in a corner was legible on a dialog;
 *    on a full page the reader is entitled to be told where it goes back to;
 *  - the open section is addressable *and looks it*: the bar states the path;
 *  - the storage health that used to ride in the bar is still stated, because
 *    a phone states the bucket's health nowhere else.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
  useMutation: () => async () => {
    throw new Error("not used in this test");
  },
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  useConvex: () => undefined,
  useQuery: () => undefined,
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import { SettingsOverlay } from "../features/console/settings/SettingsOverlay";
import { ThemeProvider } from "../features/design/theme";
import { darkColors } from "../features/design/tokens";
import type { ConsoleData } from "../features/console/types";
import type { SettingsSectionKey } from "../features/console/settings/sections";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

/** react-native-web resolves colours to `rgb()`; the tokens are hex. */
function rgb(hex: string): string {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

function mount(render: () => ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(render());
  });
  return container;
}

function demoData(): ConsoleData {
  let data: ConsoleData | null = null;
  function Probe() {
    data = useDemoConsoleData();
    return null;
  }
  mount(() => createElement(Probe));
  if (data === null) throw new Error("the demo console did not resolve");
  return data;
}

/**
 * A pointer-width mount.
 *
 * jsdom reports a viewport of 0, which is the compact branch — so the width
 * is stubbed the way `paletteRender.test.ts` stubs it, and the resize event is
 * dispatched inside `act` because react-native-web answers it with state on
 * every mounted component that reads the window.
 */
function pointer(
  section: SettingsSectionKey = "storage",
  onDismiss: () => void = () => {},
): HTMLElement {
  for (const [node, prop, value] of [
    [document.documentElement, "clientWidth", 1440],
    [document.documentElement, "clientHeight", 900],
    [window, "innerWidth", 1440],
    [window, "innerHeight", 900],
  ] as const) {
    Object.defineProperty(node, prop, { value, configurable: true });
  }
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  const data: ConsoleData = { ...demoData(), deleteAccount: async () => {} };
  mount(() =>
    createElement(ThemeProvider, {
      // Pinned, because these assert paint: jsdom answers `useColorScheme`
      // with light, so an unpinned mount would silently be testing Paper
      // while naming Graphite's tokens.
      scheme: "dark",
      children: createElement(SettingsOverlay, { data, section, onSelect: () => {}, onDismiss }),
    }),
  );
  return document.body;
}

const find = (root: HTMLElement, testID: string) =>
  root.querySelector(`[data-testid='${testID}']`) as HTMLElement | null;

/**
 * A property that is *not set*, which is what "no radius" looks like here.
 *
 * react-native-web emits a class per declared property, so a style nobody
 * declared has no declaration for jsdom to compute and comes back `""`. That
 * is the state under test, and it is still a real assertion: re-adding
 * `borderRadius: radii.console` computes to `16px` and fails this.
 */
function unset(style: CSSStyleDeclaration, property: string, zero: string): void {
  const value = style.getPropertyValue(property);
  expect([`${property}: `, `${property}: ${zero}`]).toContain(`${property}: ${value}`);
}

describe("the page fills the window", () => {
  test("the surface is not a card: no radius, no cap, no shadow", () => {
    const page = find(pointer(), "settings-overlay-panel");
    expect(page).not.toBeNull();
    const style = window.getComputedStyle(page!);
    unset(style, "border-top-left-radius", "0px");
    unset(style, "max-width", "none");
    unset(style, "max-height", "none");
    unset(style, "box-shadow", "none");
    unset(style, "border-top-width", "0px");
  });

  /*
    The scrim is the part that says "this is temporary, the thing behind it is
    the real screen". A settings page is not that, and greying out a console
    nobody can see past is a dimmed screenshot of the app for no reason.
  */
  test("nothing on the screen is a scrim", () => {
    const body = pointer();
    /*
      The literal, not "any translucent fill": this palette washes a pill and
      an inline alert in its own hue at 10%, and a test that called those
      scrims would fail on every future one. What must not come back is the
      full-screen black — `Overlay`'s own `rgba(3,3,4,.72)`.
    */
    const painted = [...body.querySelectorAll<HTMLElement>("*")].map(
      (node) => window.getComputedStyle(node).backgroundColor,
    );
    expect(painted.filter((paint) => paint.startsWith("rgba(3, 3, 4"))).toEqual([]);
    // …and nothing else is a near-opaque black wash either, whatever it is called.
    expect(
      painted.filter((paint) => /^rgba\(\d+, \d+, \d+, 0\.[5-9]/.test(paint)),
    ).toEqual([]);
  });

  test("the page paints the ground, and the pane beside it paints the chrome", () => {
    const body = pointer();
    expect(window.getComputedStyle(find(body, "settings-overlay-panel")!).backgroundColor).toBe(
      rgb(darkColors.ground),
    );
    expect(window.getComputedStyle(find(body, "settings-overlay-pane")!).backgroundColor).toBe(
      rgb(darkColors.surface),
    );
    // The one corner, and it is the pane's: the page's own four run to the edges.
    expect(window.getComputedStyle(find(body, "settings-overlay-pane")!).borderTopLeftRadius).toBe(
      "10px",
    );
  });
});

describe("the bar says where you are and how to leave", () => {
  test("the way out is a named control, not a bare glyph", () => {
    const body = pointer();
    const out = find(body, "settings-overlay-close");
    expect(out).not.toBeNull();
    expect(out!.textContent).toBe("Notes");
    expect((out!.getAttribute("aria-label") ?? "").toLowerCase()).toContain("notes");
  });

  test("pressing it closes settings and nothing else", () => {
    let closed = 0;
    const body = pointer("storage", () => (closed += 1));
    act(() => find(body, "settings-overlay-close")!.click());
    expect(closed).toBe(1);
  });

  /*
    `?settings=storage` is a real address and always was; what it never did was
    look like one. The bar states the path so that a person who is told to
    "open settings, storage" can see they got there, and so a screenshot in a
    support thread says which screen it is.
  */
  test("the bar states the open section as a path", () => {
    const bar = find(pointer("plugins"), "settings-overlay-breadcrumb");
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain("settings");
    expect(bar!.textContent).toContain("plugins");
    // The scope rides in the path too, which is what lets the pane stop
    // repeating it above every section's title.
    expect(bar!.textContent).toContain("@");
  });

  test("the storage health the bar carried is still carried", () => {
    expect(find(pointer("plugins"), "settings-health")).not.toBeNull();
  });
});

describe("the section list is a list, not a stack of boxes", () => {
  test("a group paints no card of its own", () => {
    const group = find(pointer(), "settings-group-account");
    expect(group).not.toBeNull();
    const style = window.getComputedStyle(group!);
    expect(style.borderTopWidth === "" || style.borderTopWidth === "0px").toBe(true);
    const paint = style.backgroundColor;
    expect(paint === "" || paint === "rgba(0, 0, 0, 0)" || paint === "transparent").toBe(true);
  });

  /*
    The selected row is marked rather than only filled. A fill alone is the
    one thing a reader with a contrast problem loses first, and it is what the
    rail beside the notes already does.
  */
  test("the open section carries a marker in the accent", () => {
    const marker = find(pointer("storage"), "settings-marker-storage");
    expect(marker).not.toBeNull();
    expect(window.getComputedStyle(marker!).backgroundColor).toBe(rgb(darkColors.accent));
  });

  /*
    And the marker is not a row. Every row in this list is found by prefix —
    `settings.spec.ts` sweeps `[data-testid^="settings-section-"]` to measure
    label alignment — so a marker named `settings-section-storage-marker`
    joins that sweep as a labelless row. It did, and the sweep caught it.
  */
  test("the marker does not answer to the row selector", () => {
    const rows = pointer("storage").querySelectorAll('[data-testid^="settings-section-"]');
    for (const row of rows) {
      expect(row.getAttribute("aria-label")).not.toBe(null);
    }
  });

  test("a section that is not open carries no marker", () => {
    expect(find(pointer("storage"), "settings-marker-plugins")).toBeNull();
  });
});
