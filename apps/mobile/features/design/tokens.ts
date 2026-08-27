import { Platform } from "react-native";

/**
 * Design tokens for Context, lifted verbatim from `docs/design/console-mockup.html`.
 *
 * The mockup is a single dark world by intent — every colour is painted
 * explicitly so nothing borrows a host background. There is no light theme and
 * we should not invent one; the values below are the whole palette.
 */
export const colors = {
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
} as const;

/** Edge/node colours in the constellation map, keyed by relationship. */
export const graphColors = {
  own: "#3B82F6",
  team: "#75757F",
  shared: "#8B5CF6",
  client: "#34D399",
  you: "#F2F2F4",
} as const;

export type GraphKind = keyof typeof graphColors;

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
  /** Chrome along the edges of the frame. */
  topBarHeight: 44,
  statusBarHeight: 26,
  /**
   * The compact toolbar.
   *
   * 56 rather than the 44 a pointer would need: this is the one strip of the
   * phone layout a thumb has to hit reliably, and every target on it clears the
   * 44pt minimum with room to spare.
   */
  bottomBarHeight: 56,
} as const;

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
