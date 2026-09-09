import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";

import { peekStoredSchemeSync } from "./appearancePeek";
import { readStoredScheme, writeStoredScheme, type StoredScheme } from "./appearancePrefs";
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

/* -------------------------------------------------------------------------- */
/* The remembered appearance — Light / Dark / Follow the device               */
/* -------------------------------------------------------------------------- */

/** What "Appearance" in account settings offers. `"system"` is the default. */
export type AppearanceChoice = StoredScheme | "system";

/**
 * A module-level external store, on the same shape `useLastPlace.ts` uses for
 * "the log, live for this session": a settings panel writing the choice and
 * the provider painting the app from it are two different trees, and nothing
 * shorter than a shared store keeps them from disagreeing the instant either
 * one re-renders on its own.
 *
 * ## The first paint, and why the two platforms differ
 *
 * The whole risk this section exists to manage: a stored `"light"` that
 * arrives one render late paints dark first (`resolveScheme`'s fallback) and
 * then flips, which reads as a flash rather than a choice taking effect.
 *
 * `peekStoredSchemeSync()` is what closes that gap, and it closes it two
 * different amounts on the two platforms this module ships to:
 *
 *  - **Web** answers synchronously, at module-evaluation time — before
 *    `AppearanceProvider` ever renders. The snapshot below is seeded with the
 *    real answer from the start, so there is no wrong first frame to flash
 *    from.
 *  - **Native** cannot answer synchronously (`AsyncStorage` is a bridge call),
 *    so the snapshot starts `ready: false` and `app/_layout.tsx` holds the
 *    launch image up — the same thing it already does for the auth session —
 *    until the read below resolves. The user never sees the frame in between;
 *    it exists only for as long as the launch image covers it.
 *
 * Either way, nothing downstream of `ready` ever has to guess: `choice` is
 * only ever the placeholder `"system"` while `ready` is `false`, and the one
 * caller that draws before `ready` is true (`app/_layout.tsx`) knows to wait
 * on it rather than paint.
 */
const boot = peekStoredSchemeSync();
let appearanceSnapshot: { choice: AppearanceChoice; ready: boolean } = {
  choice: boot.scheme ?? "system",
  ready: boot.resolved,
};
const appearanceListeners = new Set<() => void>();

function publishAppearance(next: { choice: AppearanceChoice; ready: boolean }): void {
  appearanceSnapshot = next;
  for (const listener of appearanceListeners) listener();
}

function subscribeAppearance(listener: () => void): () => void {
  appearanceListeners.add(listener);
  return () => {
    appearanceListeners.delete(listener);
  };
}

function currentAppearance(): { choice: AppearanceChoice; ready: boolean } {
  return appearanceSnapshot;
}

/**
 * Starts the async read at most once per process. A second mount of
 * `useAppearanceChoice` — the provider and the settings panel both use it —
 * must not issue a second device read, and once `ready` is `true` (including
 * synchronously, on web) there is nothing left to read.
 */
let readStarted = false;
function ensureAppearanceLoaded(): void {
  if (readStarted || appearanceSnapshot.ready) return;
  readStarted = true;
  void readStoredScheme().then((stored) => {
    publishAppearance({ choice: stored ?? "system", ready: true });
  });
}

/**
 * The remembered appearance choice, live, plus a setter that writes it down.
 *
 * Every reader shares one store, so a change made from the settings panel is
 * visible to `AppearanceProvider` on its very next render — the two are not
 * otherwise related components, and the whole point is that they cannot
 * disagree about what "the current choice" is.
 */
export function useAppearanceChoice(): {
  choice: AppearanceChoice;
  /** `false` only on a native cold start, before the device has answered. */
  ready: boolean;
  setChoice: (choice: AppearanceChoice) => void;
} {
  const snapshot = useSyncExternalStore(
    subscribeAppearance,
    currentAppearance,
    currentAppearance,
  );

  useEffect(() => {
    ensureAppearanceLoaded();
  }, []);

  const setChoice = useCallback((choice: AppearanceChoice) => {
    // The screen updates first — same rule `useRememberPlace` follows — so
    // every subtree reading this store repaints in the same tick rather than
    // waiting on the device to catch up.
    publishAppearance({ choice, ready: true });
    void writeStoredScheme(choice === "system" ? null : choice);
  }, []);

  return { ...snapshot, setChoice };
}

/**
 * Pins the whole app to the remembered choice, or follows the system when
 * that choice is `"system"`. The one caller of this is `app/_layout.tsx` —
 * everything else keeps using `ThemeProvider` directly, including every test
 * that pins a subtree to one scheme on purpose.
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { choice } = useAppearanceChoice();
  return <ThemeProvider scheme={choice === "system" ? undefined : choice}>{children}</ThemeProvider>;
}

/** Test seam: forget the in-process appearance state. Not used by the app. */
export function resetAppearanceForTests(): void {
  readStarted = false;
  appearanceListeners.clear();
  const boot = peekStoredSchemeSync();
  appearanceSnapshot = { choice: boot.scheme ?? "system", ready: boot.resolved };
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
