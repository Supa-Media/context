/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import {
  darkColors,
  darkGraphColors,
  darkShadows,
  lightColors,
  lightGraphColors,
  lightShadows,
} from "../features/design/tokens";
import {
  ThemeProvider,
  resolveScheme,
  useColors,
  useScheme,
  useThemedStyles,
} from "../features/design/theme";

/**
 * The theming contract.
 *
 * Three separate things are pinned here, because three separate things can
 * break silently:
 *
 *  1. **Key parity.** A token that exists in one palette and not the other is
 *     `undefined` at the call site, and `undefined` in a `backgroundColor` is
 *     not an error — it is a transparent view over whatever is behind it. The
 *     type system already refuses the mismatch (`lightColors: Colors`), but
 *     the type only sees what the file declares; a runtime assertion also
 *     covers a palette assembled by spread or by hand-editing.
 *  2. **Contrast.** The dark palette was signed off as a picture. The light one
 *     was designed against it, and the only thing keeping it honest is a
 *     measured ratio — "it looked fine in the screenshot" is how a 3:1 body
 *     text ships.
 *  3. **Which palette a component actually gets.** The hook is one line, and
 *     the way it fails is by resolving to the same palette in both schemes,
 *     which no render test that only ever runs in one scheme would notice.
 */

/* ------------------------------------------------------------------ *
 * WCAG contrast, computed here rather than imported.
 *
 * A test that shares its arithmetic with the code under test proves the two
 * agree, not that either is right. These are the formulas from WCAG 2.1
 * verbatim, typed out once.
 * ------------------------------------------------------------------ */

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function parseHex(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Rounded to 2dp so a failure message reads like the number a designer quotes. */
function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return Math.round(ratio * 100) / 100;
}

describe("contrast helper", () => {
  test("agrees with the known anchors", () => {
    expect(contrast("#000000", "#FFFFFF")).toBe(21);
    expect(contrast("#FFFFFF", "#FFFFFF")).toBe(1);
    // The canonical WCAG worked example: #777777 on white is 4.48:1 — just
    // under AA, which is the whole reason the threshold is 4.5 and not "grey".
    expect(contrast("#777777", "#FFFFFF")).toBeCloseTo(4.48, 1);
  });
});

describe("palette key parity", () => {
  test("light and dark colours declare exactly the same tokens", () => {
    expect(Object.keys(lightColors).sort()).toEqual(Object.keys(darkColors).sort());
  });

  test("light and dark graph colours declare exactly the same kinds", () => {
    expect(Object.keys(lightGraphColors).sort()).toEqual(Object.keys(darkGraphColors).sort());
  });

  test("light and dark shadows declare exactly the same elevations", () => {
    expect(Object.keys(lightShadows).sort()).toEqual(Object.keys(darkShadows).sort());
  });

  test("no token was left as its dark value", () => {
    const unchanged = Object.keys(darkColors).filter(
      (key) =>
        lightColors[key as keyof typeof lightColors] ===
        darkColors[key as keyof typeof darkColors],
    );
    expect(unchanged).toEqual([]);
  });

  test("every token is a colour string in both palettes", () => {
    const looksLikeAColour = /^(#[0-9a-f]{6}|rgba?\([\d.,\s]+\))$/i;
    const bad = [
      ...Object.entries(lightColors).map(([k, v]) => [`light.${k}`, v] as const),
      ...Object.entries(darkColors).map(([k, v]) => [`dark.${k}`, v] as const),
    ].filter(([, value]) => !looksLikeAColour.test(value));
    expect(bad).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Contrast.
 *
 * Every ratio below is against an opaque surface the token is actually drawn
 * on. The wash tokens are alpha over a surface, so a foreground measured
 * against the bare surface is the *pessimistic* reading for `ok`/`warn`/`crit`
 * — the wash always moves the ground towards the family's own hue, which can
 * only help.
 * ------------------------------------------------------------------ */

const AA = 4.5;
/** WCAG's threshold for non-text UI (a dot, a border, a focus ring). */
const AA_NON_TEXT = 3;

describe("light palette contrast", () => {
  const grounds = {
    ground: lightColors.ground,
    surface: lightColors.surface,
    surface2: lightColors.surface2,
    surface3: lightColors.surface3,
    well: lightColors.well,
  };

  test.each(Object.entries(grounds))("body text clears AA on %s", (_name, background) => {
    expect(contrast(lightColors.text, background)).toBeGreaterThanOrEqual(AA);
    expect(contrast(lightColors.text2, background)).toBeGreaterThanOrEqual(AA);
    expect(contrast(lightColors.muted, background)).toBeGreaterThanOrEqual(AA);
  });

  /**
   * The tokens that carry words. Each family's `*Text` member is the one that
   * is set as a `color`, which is why the family also has a bare member for
   * marks — a dot legible at 3:1 and a sentence legible at 4.5:1 are not the
   * same colour.
   */
  test.each([
    ["okText", lightColors.okText],
    ["warnText", lightColors.warnText],
    ["critText", lightColors.critText],
    ["accentText", lightColors.accentText],
    ["hintText", lightColors.hintText],
    ["hintStrong", lightColors.hintStrong],
    ["codeKey", lightColors.codeKey],
    ["sharedText", lightColors.sharedText],
  ])("%s clears AA on the surfaces it is drawn on", (_name, token) => {
    expect(contrast(token, lightColors.surface)).toBeGreaterThanOrEqual(AA);
    expect(contrast(token, lightColors.well)).toBeGreaterThanOrEqual(AA);
  });

  /**
   * The tokens that never carry words.
   *
   * `accent` is in this list rather than the one above because every one of
   * its call sites is a border or a fill — a focus ring, a focused input's
   * edge, a checked tick, the active tab's underline, the bottom bar's
   * indicator. `accentText` is the family's text member and is held to AA
   * above. If `accent` ever does become a `color:`, it belongs in the other
   * list and needs a darker value to get there.
   */
  test.each([
    ["accent", lightColors.accent],
    ["ok", lightColors.ok],
    ["warn", lightColors.warn],
    ["crit", lightColors.crit],
    ["warm", lightColors.warm],
  ])("the %s mark clears the non-text threshold", (_name, token) => {
    for (const background of [lightColors.surface, lightColors.ground, lightColors.well]) {
      expect(contrast(token, background)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  test("the CTA's ink is legible on the CTA's own fill", () => {
    expect(contrast(lightColors.ink, lightColors.white)).toBeGreaterThanOrEqual(AA);
  });

  test("the second hero line stays readable at hero size", () => {
    // `heroDim` is deliberately below AA — it is the dimmest thing in the
    // design and it is set at hero size, where AA is 3:1. It must not be
    // dimmer than the dark palette's own second line, which is the picture
    // that was signed off.
    expect(contrast(lightColors.heroDim, lightColors.ground)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(contrast(lightColors.heroDim, lightColors.ground)).toBeGreaterThanOrEqual(
      contrast(darkColors.heroDim, darkColors.ground),
    );
  });

  test("the text hierarchy descends", () => {
    const onSurface = (token: string) => contrast(token, lightColors.surface);
    expect(onSurface(lightColors.text)).toBeGreaterThan(onSurface(lightColors.text2));
    expect(onSurface(lightColors.text2)).toBeGreaterThan(onSurface(lightColors.muted));
    expect(onSurface(lightColors.muted)).toBeGreaterThan(onSurface(lightColors.heroDim));
  });
});

describe("dark palette contrast", () => {
  test("body text clears AA on the surfaces it is drawn on", () => {
    for (const background of [darkColors.ground, darkColors.surface, darkColors.well]) {
      expect(contrast(darkColors.text, background)).toBeGreaterThanOrEqual(AA);
      expect(contrast(darkColors.text2, background)).toBeGreaterThanOrEqual(AA);
    }
  });

  test("the text hierarchy descends", () => {
    const onSurface = (token: string) => contrast(token, darkColors.surface);
    expect(onSurface(darkColors.text)).toBeGreaterThan(onSurface(darkColors.text2));
    expect(onSurface(darkColors.text2)).toBeGreaterThan(onSurface(darkColors.muted));
    expect(onSurface(darkColors.muted)).toBeGreaterThan(onSurface(darkColors.heroDim));
  });

  /**
   * `muted` in the signed-off dark palette lands at 4.26:1 on `surface` —
   * under AA. It is pinned rather than fixed because the dark values are the
   * mockup and changing them is a redesign, not a light-mode change. The light
   * palette is held to the real threshold above; this exists so that if
   * somebody does revisit the dark values, the number they are moving is
   * written down rather than rediscovered.
   */
  test("muted is a known, pinned exception", () => {
    expect(contrast(darkColors.muted, darkColors.surface)).toBeCloseTo(4.26, 1);
  });
});

/* ------------------------------------------------------------------ *
 * Resolution and the hooks.
 * ------------------------------------------------------------------ */

describe("resolveScheme", () => {
  test("an explicit choice wins over the system", () => {
    expect(resolveScheme("light", "dark")).toBe("light");
    expect(resolveScheme("dark", "light")).toBe("dark");
  });

  test("with no choice it follows the system", () => {
    expect(resolveScheme(null, "light")).toBe("light");
    expect(resolveScheme(null, "dark")).toBe("dark");
  });

  test("a system that will not say falls back to dark", () => {
    // Dark is the app's own ground: every screen paints it explicitly and it
    // is what shipped for the whole life of the app before this. A platform
    // that reports nothing should land there rather than on the newer half.
    expect(resolveScheme(null, null)).toBe("dark");
    expect(resolveScheme(null, undefined)).toBe("dark");
  });
});

function mount(node: ReactNode): () => void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(node);
  });
  return () => {
    act(() => {
      root.unmount();
    });
    host.remove();
  };
}

/** Renders `probe` inside a provider and hands back what the hook returned. */
function readHook<T>(scheme: "light" | "dark" | undefined, probe: () => T): T {
  let seen!: T;
  function Probe() {
    seen = probe();
    return null;
  }
  const unmount = mount(
    createElement(ThemeProvider, { scheme, children: createElement(Probe) }),
  );
  unmount();
  return seen;
}

describe("useColors", () => {
  test("hands back the light palette under a light provider", () => {
    expect(readHook("light", useColors)).toBe(lightColors);
  });

  test("hands back the dark palette under a dark provider", () => {
    expect(readHook("dark", useColors)).toBe(darkColors);
  });

  test("reports the scheme it resolved", () => {
    expect(readHook("light", useScheme)).toBe("light");
    expect(readHook("dark", useScheme)).toBe("dark");
  });

  test("works with no provider at all", () => {
    // Most of this suite mounts components on their own. A hook that threw
    // without a provider would turn every one of those into a crash, so the
    // fallback is part of the contract rather than a convenience.
    let seen: unknown;
    function Probe() {
      seen = useColors();
      return null;
    }
    const unmount = mount(createElement(Probe));
    unmount();
    expect([lightColors, darkColors]).toContain(seen);
  });
});

describe("useThemedStyles", () => {
  const makeStyles = (colors: { surface: string }) => ({
    panel: { backgroundColor: colors.surface },
  });

  test("builds the styles from the palette in force", () => {
    expect(readHook("light", () => useThemedStyles(makeStyles)).panel.backgroundColor).toBe(
      lightColors.surface,
    );
    expect(readHook("dark", () => useThemedStyles(makeStyles)).panel.backgroundColor).toBe(
      darkColors.surface,
    );
  });

  test("returns one stable object per scheme rather than a new one per render", () => {
    // Identity matters: these land in `style` props that `React.memo` and
    // react-native-web's style resolver both compare by reference.
    const first = readHook("dark", () => useThemedStyles(makeStyles));
    const second = readHook("dark", () => useThemedStyles(makeStyles));
    expect(first).toBe(second);

    const light = readHook("light", () => useThemedStyles(makeStyles));
    expect(light).not.toBe(first);
  });

  test("a factory that reads shadows gets the matching set", () => {
    const withShadow = (_c: unknown, shadows: { floating: string }) => ({
      bar: { boxShadow: shadows.floating },
    });
    expect(readHook("light", () => useThemedStyles(withShadow)).bar.boxShadow).toBe(
      lightShadows.floating,
    );
    expect(readHook("dark", () => useThemedStyles(withShadow)).bar.boxShadow).toBe(
      darkShadows.floating,
    );
  });
});
