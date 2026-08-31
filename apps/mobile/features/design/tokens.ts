import { Platform } from "react-native";

/**
 * Design tokens for Context.
 *
 * The dark palette is lifted verbatim from `docs/design/console-mockup.html`,
 * which is the signed-off design and remains the app's own ground: every
 * colour is painted explicitly so nothing borrows a host background.
 *
 * There is now a light palette beside it, because `app.config.js` declares
 * `userInterfaceStyle: "automatic"` and that should be true rather than
 * aspirational. It is a **design**, not an inversion — see `lightColors` for
 * where the two deliberately diverge and why.
 *
 * Neither palette is a module-level global any more. Screens obtain one
 * through `useColors()` / `useThemedStyles()` in `./theme`; non-React code
 * takes a `Colors` as an argument. Importing a palette by name is for the
 * tokens themselves, for tests, and for nothing else — a `StyleSheet.create`
 * that closes over one is a screen that can never change appearance, and that
 * is exactly the bug this file used to guarantee.
 */
export const darkColors = {
  ground: "#050506",
  surface: "#0B0B0D",
  surface2: "#111114",
  surface3: "#18181C",

  /** Hairline separators. RN has no `currentColor`, so these are literal rgba. */
  line: "rgba(255,255,255,0.07)",
  lineStrong: "rgba(255,255,255,0.14)",

  text: "#F2F2F4",
  text2: "#A8A8B2",
  muted: "#75757F",
  /** The second hero line, deliberately dimmer than `muted`. */
  heroDim: "#5E5E68",

  accent: "#3B82F6",
  accentDim: "rgba(59,130,246,0.13)",
  accentText: "#CFE0FF",

  ok: "#34D399",
  okText: "#6EE7B7",
  okWash: "rgba(52,211,153,0.10)",
  okBorder: "rgba(52,211,153,0.22)",

  warn: "#FBBF24",
  warnText: "#FCD34D",
  warnWash: "rgba(251,191,36,0.10)",
  warnBorder: "rgba(251,191,36,0.22)",

  crit: "#F87171",
  critText: "#FCA5A5",
  critBorder: "rgba(248,113,113,0.24)",
  critWash: "rgba(248,113,113,0.09)",

  /**
   * The violet that means "somebody else's access" — `graphColors.shared`'s
   * family, as a wash and a label.
   *
   * Tokens rather than the two literals that used to sit in
   * `ContinuityDemo.tsx`: a hardcoded `#D8C9FF` is legible on this ground and
   * invisible on the light one, and a colour with no token is a colour no
   * palette can answer for.
   */
  sharedWash: "rgba(139,92,246,0.13)",
  sharedText: "#D8C9FF",

  /** Inverse ink, used on the white CTA and on the "You" node in the map. */
  ink: "#08080A",
  white: "#F2F2F4",

  /** The near-black used for insets: code blocks, the map field, field values. */
  well: "#030304",

  /** Warm accent for the first floating tile's mark. */
  warm: "#FB9256",

  hintWash: "rgba(59,130,246,0.06)",
  hintBorder: "rgba(59,130,246,0.16)",
  hintText: "#B9CEF5",
  hintStrong: "#DCE8FF",

  /** Syntax tints in the note preview. */
  codeKey: "#7DA6F5",

  /* ------------------------------------------------------------------ *
   * Floating chrome.
   *
   * On a phone the controls are not a bar with a rule under it — they are
   * objects lying over the note, the way Obsidian mobile draws them. That
   * needs a surface that reads as *above* `surface` without a border to say
   * so, because a border is exactly what a floating object does not have.
   * `surface3` is the hover tint for a row inside a panel and is too close to
   * its own ground to carry an edge on its own; these two are a step further
   * out, and the shadow underneath does the rest.
   * ------------------------------------------------------------------ */
  chrome: "#191920",
  chromePressed: "#24242C",
} as const;

/**
 * The shape both palettes share.
 *
 * Deliberately `Record<keyof typeof darkColors, string>` rather than
 * `typeof darkColors`: the latter carries the dark literals, so a light
 * palette could only satisfy it by being the dark one. This form still makes
 * a missing key a compile error and an invented key an excess-property error,
 * which is the property that matters — a token that exists in one palette and
 * not the other resolves to `undefined`, and `undefined` in `backgroundColor`
 * is a transparent view rather than a crash.
 */
export type Colors = Readonly<Record<keyof typeof darkColors, string>>;

/**
 * The light palette.
 *
 * Designed against the dark one rather than derived from it. Three notes on
 * where a mechanical inversion would have been wrong:
 *
 * **The elevation stack is re-ranked, on purpose.** In the dark palette
 * `ground < surface < surface2 < surface3` ascend in lightness, because there
 * both *elevation* (a panel lifts off the page) and *interaction* (a row tints
 * under the pointer) move the same way: towards light. In a light world they
 * move in opposite directions — a raised panel goes towards white, a hovered
 * row goes towards grey — so no single lightness ranking can carry both roles.
 * The tokens are therefore placed by the job each one does, which is the
 * relationship worth preserving:
 *
 *   - `ground` is the page.
 *   - `surface` is the panel on it.
 *   - `surface2` is the faint fill: a pointer layout's toolbar, a raised card.
 *   - `surface3` is the stronger tint: a menu row under the pointer, a ghost
 *     button's fill, a neutral pill, a selected row on a phone.
 *   - `well` stays the deepest inset, as it is in the dark palette.
 *
 * **`ground` and `surface` are both white, and that is the design rather than
 * a value nobody filled in.** This palette used to ground at `#EDEDF2` with
 * `#14141A` ink so that a white panel could lift off the page without a
 * border. On a desktop that is a defensible picture and on a phone it is the
 * single thing that made the app read as grey: the note, the file tree and the
 * chrome are each the widest object on the glass, there is nothing for them to
 * lift *off*, and the grey shows through as a tint over the whole document.
 * Obsidian on iOS — which is the surface this app is measured against, and
 * which most of its users already have open — paints paper white and separates
 * regions with a shadow and a hairline instead. So do we. The hairlines
 * (`line`) and the three shadows are what carry the separation now, which is
 * why neither may be dropped as "invisible": on this ground they are the only
 * edges there are.
 *
 * **`white` and `ink` keep their roles, not their names.** `white` is the
 * primary CTA's fill and `ink` is the label on it; in the dark world that is a
 * near-white button with near-black text. Inverting the world inverts the
 * button, so here `white` is near-black and `ink` is white. The names read as
 * lies in this half of the file and the values are still right — renaming them
 * would touch every call site for no behavioural gain, so the roles are
 * documented instead.
 *
 * **Pressed states darken rather than lighten.** `chromePressed` is lighter
 * than `chrome` in the dark palette and darker than it here. Both mean the
 * same thing — more ink under the thumb — and following the dark direction
 * would have made a pressed control brighter than the white it sits on, which
 * is not a press.
 *
 * Contrast is asserted, not asserted-in-prose: see `__tests__/theme.test.ts`.
 */
export const lightColors: Colors = {
  ground: "#FFFFFF",
  surface: "#FFFFFF",
  surface2: "#FAFAFA",
  surface3: "#F1F1F3",

  /** Hairline separators — black at low alpha, mirroring the dark palette's white. */
  line: "rgba(0,0,0,0.09)",
  lineStrong: "rgba(0,0,0,0.18)",

  /**
   * Ink, and its two quieter voices.
   *
   * `#222222` rather than a near-black with a blue cast. The cast was there to
   * agree with a grey-blue ground that no longer exists; against paper it is a
   * tint nobody asked for on every word in the app, and the type it is set in
   * is a body face at 16/24 rather than a display face where a cool black
   * reads as deliberate.
   */
  text: "#222222",
  text2: "#444444",
  muted: "#6B6B6B",
  /** The second hero line, deliberately dimmer than `muted`. */
  heroDim: "#858585",

  accent: "#2563EB",
  accentDim: "rgba(37,99,235,0.10)",
  accentText: "#1D4ED8",

  ok: "#068A5F",
  okText: "#065F46",
  okWash: "rgba(6,138,95,0.10)",
  okBorder: "rgba(6,138,95,0.28)",

  warn: "#B45309",
  warnText: "#92400E",
  warnWash: "rgba(180,83,9,0.12)",
  warnBorder: "rgba(180,83,9,0.30)",

  crit: "#DC2626",
  critText: "#B91C1C",
  critBorder: "rgba(220,38,38,0.28)",
  critWash: "rgba(220,38,38,0.08)",

  sharedWash: "rgba(124,58,237,0.10)",
  sharedText: "#5B21B6",

  /** See the note above: the CTA fill is dark here, and its ink is white. */
  ink: "#FFFFFF",
  white: "#14141A",

  /**
   * The recessed grey used for insets: code blocks, the map field, field
   * values — and, in a note, the ground under an inline `code` span, which is
   * where most people will actually see it.
   */
  well: "#F5F5F5",

  /** Warm accent for the first floating tile's mark. */
  warm: "#C2410C",

  hintWash: "rgba(37,99,235,0.06)",
  hintBorder: "rgba(37,99,235,0.22)",
  hintText: "#2A57C4",
  hintStrong: "#1B3F96",

  /** Syntax tints in the note preview. */
  codeKey: "#2A5DB0",

  /**
   * Floating chrome. A floating object in a light world is white and reads as
   * above the page through its shadow rather than through being brighter than
   * everything under it — there is nothing brighter than white.
   */
  chrome: "#FFFFFF",
  chromePressed: "#E9E9F0",
};

/** Edge/node colours in the constellation map, keyed by relationship. */
export const darkGraphColors = {
  own: "#3B82F6",
  team: "#75757F",
  shared: "#8B5CF6",
  client: "#34D399",
  you: "#F2F2F4",
} as const;

export type GraphKind = keyof typeof darkGraphColors;

export type GraphColors = Readonly<Record<GraphKind, string>>;

/**
 * The same five relationships, at light-mode contrast.
 *
 * `you` follows `white`/`ink`: it is the emphasised node, so it is the one
 * disc drawn in the ground's opposite — near-black here, near-white there.
 */
export const lightGraphColors: GraphColors = {
  own: "#2563EB",
  team: "#626270",
  shared: "#7C3AED",
  client: "#059669",
  you: "#14141A",
};

/**
 * Font families.
 *
 * On web these are CSS font stacks — the faces themselves are pulled from
 * Google Fonts (see `fonts.web.ts` and `app/+html.tsx`), exactly as the mockup
 * does. On native we deliberately hand back `undefined` so the platform
 * default is used: passing a comma-separated stack to a native text node is
 * meaningless on iOS and can throw on Android, and there are no bundled font
 * binaries to point at yet. Native is a later surface; see the report.
 */
const webStack = (primary: string, fallback: string) => `${primary}, ${fallback}`;

export const fonts = {
  display: Platform.select({
    web: webStack("Onest", "ui-sans-serif, system-ui, sans-serif"),
    default: undefined,
  }),
  body: Platform.select({
    web: webStack(
      "Instrument Sans",
      "ui-sans-serif, system-ui, -apple-system, sans-serif",
    ),
    default: undefined,
  }),
  mono: Platform.select({
    web: webStack("JetBrains Mono", "ui-monospace, SFMono-Regular, Menlo, monospace"),
    default: Platform.select({ ios: "Menlo", default: "monospace" }),
  }),
} as const;

export const radii = {
  xs: 6,
  sm: 7,
  md: 8,
  lg: 9,
  xl: 10,
  card: 12,
  panel: 13,
  console: 16,
  tile: 26,
  cta: 11,
  pill: 999,

  /* ------------------------------------------------------------------ *
   * Phone geometry.
   *
   * The radii above are a pointer application's: 6–16, drawn small because a
   * 13px row inside a 12px card inside a 16px panel has to nest three
   * corners inside 40px of height. A phone nests nothing — a sheet, a
   * toolbar and a grouped card are each the widest thing on the screen — so
   * they are drawn at the scale iOS and Obsidian mobile draw them at, and
   * using the pointer scale there is the single loudest way a phone layout
   * reads as a shrunken desktop.
   * ------------------------------------------------------------------ */
  /** A grouped list card, and the drawer's trailing corners. */
  sheet: 18,
  /** The floating toolbar and anything else lying over the note. */
  floating: 20,
  /** A control on a phone: a circular button is `pill`, a square one is this. */
  control: 14,
} as const;

export const space = {
  x1: 4,
  x2: 8,
  x3: 12,
  x4: 16,
  x5: 20,
  x6: 24,
  x7: 28,
  x8: 32,
} as const;

/**
 * The touch minimum, hoisted so `layout` can derive from it.
 *
 * A `const` object cannot reference its own members while it is being built,
 * and the alternative — writing `44` twice and claiming in a comment that the
 * two agree — is exactly the shape this repo keeps getting bitten by.
 */
const MIN_TOUCH_TARGET = 44;

/** The mockup's `.wrap`: `max-width:1200px; padding:0 28px`. */
export const layout = {
  maxWidth: 1200,
  gutter: 28,
  /** `@media(max-width:880px)` — rail goes horizontal, browse goes single column. */
  narrowBreakpoint: 880,
  /** `@media(max-width:1080px)` — floating tiles are hidden. */
  tileBreakpoint: 1080,
  railWidth: 216,
  treeWidth: 246,
  consoleBodyMinHeight: 566,
  mapHeight: 398,

  /* ---------------------------------------------------------------------- *
   * The application frame.
   *
   * These belong to `features/app/frame.ts`, which decides which regions are
   * on screen at a given width. They live here rather than there for the same
   * reason every other measure does: a number that decides a layout should be
   * readable beside the other numbers that decide layouts.
   * ---------------------------------------------------------------------- */

  /** Above this the rail can afford its labels and everything is visible. */
  wideBreakpoint: 1180,
  /** The rail reduced to its marks, for a medium window. */
  railIconWidth: 56,
  /** The explorer column's resting width, and the range a drag may take it to. */
  explorerWidth: 260,
  explorerMinWidth: 200,
  explorerMaxWidth: 460,
  /**
   * The smallest target a thumb can be asked to hit, in points.
   *
   * 44 is Apple's HIG minimum and Android's 48dp rounds down to about the same
   * physical size. It lives here rather than in the one component that first
   * needed it because it is not the bottom bar's rule — it is the rule for
   * every control a phone offers, and the top bar's navigation control is one.
   * `BottomBar` re-exports it as `MIN_TOUCH_TARGET` so its tests keep asserting
   * the same number the styles use.
   *
   * Not yet universal: `Menu`, `Menu.web` and `Palette` still type `44` for
   * this same rule and should be moved onto the token rather than the token's
   * description being trimmed to match them.
   */
  minTouchTarget: MIN_TOUCH_TARGET,
  /**
   * Chrome along the edges of the frame.
   *
   * A touch target **plus its hairline**, not equal to one. React Native
   * Web sets `box-sizing: border-box` on every `View` and Yoga measures the
   * same way, so a 44 bar with a 1px bottom rule leaves a 43 content box — and
   * a control stretching to fill it is a pixel short of the minimum, or clamps
   * itself back to 44 and hangs that pixel under the bar where the body paints
   * over it. One more pixel here and a control that fills the bar is exactly a
   * touch target, with no number of its own.
   *
   * Derived rather than typed again: an equality asserted in prose beside two
   * independent literals is an equality that quietly stops being true.
   */
  topBarHeight: MIN_TOUCH_TARGET + 1,
  statusBarHeight: 26,
  /**
   * The compact toolbar.
   *
   * 56 rather than the 44 a pointer would need: this is the one strip of the
   * phone layout a thumb has to hit reliably, and every target on it clears the
   * 44pt minimum with room to spare.
   */
  bottomBarHeight: 56,
  /**
   * The gap between the floating toolbar and the edges of the glass.
   *
   * The toolbar is a pill lying on the note rather than a bar ruled off from
   * it, so the frame reserves `bottomBarHeight` **plus twice this** along the
   * bottom edge. Reserved rather than overlaid: Obsidian lets the document
   * run under its toolbar and pays for it with bottom padding inside the
   * scroller, and this app has four different things in that slot — a note, a
   * folder listing, a settings document, a map — so the padding would have to
   * be right in four places instead of one.
   */
  floatingInset: 10,
  /**
   * A circular control in the floating chrome.
   *
   * Exactly `minTouchTarget`, and derived from it rather than typed, because
   * this is the one control shape with no room to make up the difference.
   * Elsewhere a small mark sits inside a larger pressable — the bottom bar's
   * icons are 22 inside a 56pt target — so the drawing and the target are
   * separate numbers. Here the visible circle *is* the target: there is no
   * padding around it to grow, and anything below the floor is a control that
   * looks deliberate and misses under a thumb.
   *
   * The first draft of this was 40, with a comment claiming it was above the
   * floor. `appFrameRender.test.ts` caught it, which is the only reason this
   * paragraph is here rather than a 40 in a shipped build.
   */
  chromeButton: MIN_TOUCH_TARGET,
  /**
   * A row in a grouped list on a phone.
   *
   * Above `minTouchTarget` for the same reason the toolbar is: the floor is
   * what a control must not go below, not what a comfortable list row is.
   *
   * **The file tree is no longer one of these** — see `explorerRow`. A list of
   * settings is a handful of rows a thumb picks one from; a file tree is the
   * only way to reach a note on a phone and is read as a *list*, where the
   * number of rows on screen at once is the thing that decides whether it is
   * usable.
   */
  touchRow: 48,

  /* ---------------------------------------------------------------------- *
   * The file tree on a phone, measured off Obsidian on iOS.
   *
   * These three numbers are one measurement, not three preferences, and they
   * were taken from a 1320×2868 screenshot (440×956pt at @3x) rather than
   * eyeballed: the row pitch, the step between two levels, and where a
   * top-level name begins. Getting one of them right and the others near is
   * what makes a tree read as "nearly Obsidian", which is worse than not
   * trying — a half-matched rhythm reads as a bug rather than as a style.
   * ---------------------------------------------------------------------- */

  /**
   * The row pitch. **Below `minTouchTarget` on purpose**, which is legal here
   * and nowhere else: the row is drawn at 36 and the pressable carries
   * `explorerRowSlop` of `hitSlop` on each edge, so what a thumb hits is 44.
   * See `PressRow`'s `hitSlop` — pad the pressable, not the visual.
   */
  explorerRow: 36,
  /** `(minTouchTarget - explorerRow) / 2`, derived so the two cannot drift. */
  explorerRowSlop: (MIN_TOUCH_TARGET - 36) / 2,
  /** One level of nesting. */
  explorerIndent: 16,
  /** Where a top-level row's *name* starts, chevron gutter included. */
  explorerInset: 37,
} as const;

/**
 * Elevation, as `boxShadow` strings.
 *
 * React Native 0.76+ accepts the CSS shorthand on `View`, and react-native-web
 * has always passed it through, so one string serves both surfaces — which is
 * the only reason these are here rather than as a pair of platform files.
 *
 * There are three because there are three things that float, and they are lit
 * from different places: a toolbar lying on the note casts down, a drawer
 * sliding from the left edge casts sideways, and a sheet rising from the
 * bottom casts up. One shadow reused for all three is what makes a dark
 * interface look flat — every edge glows the same amount and nothing reads as
 * nearer than anything else.
 */
export const darkShadows = {
  /** The bottom toolbar, and the circular buttons in the top corners. */
  floating: "0 6px 20px -6px rgba(0,0,0,0.85), 0 1px 3px rgba(0,0,0,0.5)",
  /** A drawer or nav sheet coming in from the leading edge. */
  drawer: "24px 0 60px -20px rgba(0,0,0,0.9)",
  /** A sheet rising from the bottom edge. */
  rising: "0 -10px 40px -12px rgba(0,0,0,0.9)",
} as const;

export type Shadows = Readonly<Record<keyof typeof darkShadows, string>>;

/**
 * The same three elevations, lit for a light world.
 *
 * The geometry is identical — same offsets, same blurs, same spread — because
 * the argument for three shadows rather than one is about *where each thing is
 * lit from*, and that does not change with the palette. Only the ink does:
 * a 0.85-alpha black under a white toolbar is a bruise, not a shadow. The
 * colour is a desaturated blue-black rather than pure black so the shade sits
 * in the same hue family as the greys it falls on.
 */
export const lightShadows: Shadows = {
  floating: "0 6px 20px -6px rgba(16,16,28,0.18), 0 1px 3px rgba(16,16,28,0.10)",
  drawer: "24px 0 60px -20px rgba(16,16,28,0.22)",
  rising: "0 -10px 40px -12px rgba(16,16,28,0.20)",
};

/**
 * CSS `clamp(min, preferred, max)` where the preferred term is a viewport
 * percentage. RN has no viewport units, so the caller passes the measured
 * window width.
 */
export function clamp(min: number, vwPercent: number, max: number, width: number): number {
  return Math.min(max, Math.max(min, (width * vwPercent) / 100));
}

/**
 * CSS letter-spacing is in `em`; React Native's is in points. Convert against
 * the size the text is actually rendered at so tracking scales with the type.
 */
export function tracking(fontSize: number, em: number): number {
  return fontSize * em;
}

/**
 * CSS `line-height: 1.55` is a multiplier; RN wants points.
 */
export function leading(fontSize: number, multiple: number): number {
  return Math.round(fontSize * multiple * 100) / 100;
}
