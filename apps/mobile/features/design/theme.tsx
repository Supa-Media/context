import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Appearance, useWindowDimensions } from "react-native";

import {
  darkColors,
  darkGraphColors,
  darkShadows,
  lightColors,
  lightGraphColors,
  lightShadows,
  type Colors,
  type GraphColors,
  type Shadows,
} from "./tokens";
import { layout } from "./tokens/layout";
import { darkPhoneColors, lightPhoneColors } from "./tokens/phoneColors";
import { currentAppearance, subscribeAppearance, type Appearance as AppearanceChoice } from "./appearance";

/**
 * Which of the two palettes a subtree draws in, and how a screen gets hold of
 * it.
 *
 * ## Why a hook rather than a module-level `colors`
 *
 * The palette used to be one frozen object, so `StyleSheet.create` could close
 * over it at module load and every screen was a dark screen forever. That is
 * fine while there is one world and a silent, total failure the moment there
 * are two: the styles are built once, before any component mounts, and no
 * amount of re-rendering rebuilds them.
 *
 * So styles are now built *from* a palette rather than *with* one — see
 * `useThemedStyles` — and the palette arrives through React, where a change of
 * appearance is a re-render like any other.
 *
 * ## Why the provider is optional
 *
 * `Appearance` already answers the question on every platform this app
 * ships to, so the hooks below work with no provider above them. The provider
 * exists for the one case the platform cannot answer: a test that needs to
 * mount a screen in a named scheme.
 *
 * ## The person's choice comes first
 *
 * Light, Dark, or follow the device, chosen in Settings › Profile or from the
 * account menu (Dev2, 2026-10-14). The choice lives in `appearance.ts` — a
 * module store kept on the device and on the account — and is read here
 * through `useSyncExternalStore`, so the picker and every hook below are one
 * value. A provider's `scheme` still outranks it: a surface pinned light (the
 * landing page's sign-up) stays light whatever the person picked.
 */

/**
 * Re-exported so a screen needs one import, not two, to type its style
 * factory: the palette shape and the hook that hands one over are the same
 * idea, and splitting them across files only makes the import list longer.
 */
export type { Colors, GraphColors, Shadows } from "./tokens";

export type Scheme = "light" | "dark";

/** Everything that changes between the two worlds. */
export interface Theme {
  scheme: Scheme;
  colors: Colors;
  shadows: Shadows;
  graphColors: GraphColors;
}

const THEMES: Record<Scheme, Theme> = {
  dark: {
    scheme: "dark",
    colors: darkColors,
    shadows: darkShadows,
    graphColors: darkGraphColors,
  },
  light: {
    scheme: "light",
    colors: lightColors,
    shadows: lightShadows,
    graphColors: lightGraphColors,
  },
};

/**
 * Which palette draws: the scheme's own, or its phone variant.
 *
 * A phone draws Apple Notes contrast — true black or white ground, full ink,
 * a stronger gray (`tokens/phoneColors.ts`; owner, 2026-10-16, "Phone only").
 * "Phone" is the app's one narrow test, the width `densityFor` calls compact,
 * so a laptop window dragged narrow gets it too, the way it gets the phone's
 * layout.
 */
export type Palette = Scheme | "darkPhone" | "lightPhone";

const PALETTES: Record<Palette, Theme> = {
  ...THEMES,
  darkPhone: { ...THEMES.dark, colors: darkPhoneColors },
  lightPhone: { ...THEMES.light, colors: lightPhoneColors },
};

export function paletteFor(scheme: Scheme, width: number): Palette {
  if (width >= layout.narrowBreakpoint) return scheme;
  return scheme === "dark" ? "darkPhone" : "lightPhone";
}

/**
 * An explicit choice from a provider, or `null` for "follow the system".
 *
 * `null` rather than `undefined` so that "no provider" and "a provider that
 * chose to follow the system" are the same state and resolve the same way.
 */
const SchemeContext = createContext<Scheme | null>(null);

/**
 * The one place the two inputs are combined.
 *
 * Extracted from the hook so it can be tested as the six-case truth table it
 * is, without a renderer: a bug here is a whole app in the wrong colours, and
 * the interesting case — a platform that answers neither `"light"` nor
 * `"dark"` — is the one hardest to stage inside a render test.
 */
export function resolveScheme(
  chosen: Scheme | null | undefined,
  system: string | null | undefined,
): Scheme {
  if (chosen === "light" || chosen === "dark") return chosen;
  if (system === "light") return "light";
  // Dark for `"dark"` and for anything else, including `null`. Dark is the
  // app's own ground — every screen paints it explicitly, and it is what
  // shipped for the whole life of the app before light mode existed — so a
  // platform that will not say should land there rather than on the newer half.
  return "dark";
}

/**
 * The device's appearance, read live rather than remembered per call site.
 *
 * Not react-native's `useColorScheme`, because on web that hook (from
 * react-native-web) keeps its own `useState` per call and re-subscribes after
 * every render. A browser calls the media query's listeners one at a time and
 * React renders the first one's update before the next is called, so that
 * render unsubscribes every later hook in the subtree mid-dispatch and they
 * never hear the change: `useColors` and `useThemedStyles` in one component
 * would disagree until a reload. `themeLiveSwitch.test.ts` stages exactly that.
 *
 * `useSyncExternalStore` fixes both halves: `subscribe` is one module-level
 * function, so a render never re-subscribes, and the snapshot is read on every
 * render, so a component re-rendered for any reason draws the current scheme.
 */
function subscribeToAppearance(onChange: () => void): () => void {
  const subscription = Appearance.addChangeListener(onChange);
  return () => subscription.remove();
}

function readAppearance() {
  return Appearance.getColorScheme();
}

function useSystemScheme() {
  return useSyncExternalStore(subscribeToAppearance, readAppearance, readAppearance);
}

/** The person's Light / Dark / follow-the-device choice (`appearance.ts`). */
export function useAppearance(): AppearanceChoice {
  return useSyncExternalStore(subscribeAppearance, currentAppearance, currentAppearance);
}

/** A choice of "system" pins nothing, so it falls through to the device. */
function pinned(appearance: AppearanceChoice): Scheme | null {
  return appearance === "system" ? null : appearance;
}

export function ThemeProvider({
  scheme,
  children,
}: {
  /** Pin the subtree to one appearance. Omit to follow the person's choice. */
  scheme?: Scheme;
  children: ReactNode;
}) {
  const system = useSystemScheme();
  const chosen = useAppearance();
  const resolved = resolveScheme(scheme ?? pinned(chosen), system);
  return <SchemeContext.Provider value={resolved}>{children}</SchemeContext.Provider>;
}

/** The appearance in force for this subtree. */
export function useScheme(): Scheme {
  const provided = useContext(SchemeContext);
  const system = useSystemScheme();
  const chosen = useAppearance();
  return resolveScheme(provided ?? pinned(chosen), system);
}

/** The palette in force for this subtree, at this window's width. */
export function usePalette(): Palette {
  const scheme = useScheme();
  const { width } = useWindowDimensions();
  return paletteFor(scheme, width);
}

export function useTheme(): Theme {
  return PALETTES[usePalette()];
}

/** The palette in force. The common case, and the only one most screens need. */
export function useColors(): Colors {
  return PALETTES[usePalette()].colors;
}

/**
 * A `StyleSheet.create` block, built from the palette in force.
 *
 * The factory is expected to be a module-level `const` — one function object
 * for the life of the process — so the result can be cached per factory per
 * scheme rather than per component instance. That matters for identity:
 * `React.memo` and react-native-web's style resolver both compare `style`
 * props by reference, and a fresh `StyleSheet.create` on every render defeats
 * both.
 *
 * ```ts
 * const makeStyles = (colors: Colors) => StyleSheet.create({ … });
 *
 * export function Panel() {
 *   const styles = useThemedStyles(makeStyles);
 *   …
 * }
 * ```
 *
 * The parameter is named `colors` and the result `styles` throughout the app
 * on purpose: it makes the conversion of an existing module-scope stylesheet a
 * two-line change, with every `colors.x` inside the block and every
 * `styles.x` outside it left exactly as it was.
 */
export type StyleFactory<T> = (colors: Colors, shadows: Shadows) => T;

const cache = new WeakMap<StyleFactory<unknown>, Partial<Record<Palette, unknown>>>();

export function useThemedStyles<T>(factory: StyleFactory<T>): T {
  const palette = usePalette();
  return useMemo(() => {
    let byPalette = cache.get(factory as StyleFactory<unknown>);
    if (!byPalette) {
      byPalette = {};
      cache.set(factory as StyleFactory<unknown>, byPalette);
    }
    if (!(palette in byPalette)) {
      const theme = PALETTES[palette];
      byPalette[palette] = factory(theme.colors, theme.shadows);
    }
    return byPalette[palette] as T;
  }, [factory, palette]);
}
