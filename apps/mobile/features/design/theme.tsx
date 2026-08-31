import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useColorScheme } from "react-native";

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
 * `useColorScheme()` already answers the question on every platform this app
 * ships to, so the hooks below work with no provider above them. The provider
 * exists for the two cases the platform cannot answer: a test that needs to
 * mount a screen in a named scheme, and (later) a user who wants to pin the
 * app to one appearance regardless of the system. Making it required would
 * have meant a crash in every one of the hundred-odd tests that mount a
 * component on its own, in exchange for nothing.
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

export function ThemeProvider({
  scheme,
  children,
}: {
  /** Pin the subtree to one appearance. Omit to follow the system. */
  scheme?: Scheme;
  children: ReactNode;
}) {
  const system = useColorScheme();
  const resolved = resolveScheme(scheme ?? null, system);
  return <SchemeContext.Provider value={resolved}>{children}</SchemeContext.Provider>;
}

/** The appearance in force for this subtree. */
export function useScheme(): Scheme {
  const chosen = useContext(SchemeContext);
  const system = useColorScheme();
  return resolveScheme(chosen, system);
}

export function useTheme(): Theme {
  return THEMES[useScheme()];
}

/** The palette in force. The common case, and the only one most screens need. */
export function useColors(): Colors {
  return THEMES[useScheme()].colors;
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

const cache = new WeakMap<StyleFactory<unknown>, Partial<Record<Scheme, unknown>>>();

export function useThemedStyles<T>(factory: StyleFactory<T>): T {
  const scheme = useScheme();
  return useMemo(() => {
    let bySchema = cache.get(factory as StyleFactory<unknown>);
    if (!bySchema) {
      bySchema = {};
      cache.set(factory as StyleFactory<unknown>, bySchema);
    }
    if (!(scheme in bySchema)) {
      const theme = THEMES[scheme];
      bySchema[scheme] = factory(theme.colors, theme.shadows);
    }
    return bySchema[scheme] as T;
  }, [factory, scheme]);
}
