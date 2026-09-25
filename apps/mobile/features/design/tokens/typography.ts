import { Platform } from "react-native";

/**
 * Font families.
 *
 * On web these are CSS font stacks — the faces themselves are pulled from
 * Google Fonts (see `fonts.web.ts` and `public/index.html`), exactly as the mockup
 * does. On native we deliberately hand back `undefined` so the platform
 * default is used: passing a comma-separated stack to a native text node is
 * meaningless on iOS and can throw on Android, and there are no bundled font
 * binaries to point at yet. Native is a later surface; see the report.
 */
const webStack = (primary: string, fallback: string) => `${primary}, ${fallback}`;

export const fonts = {
  /**
   * The display voice.
   *
   * It was Onest, a second sans bought and shipped alongside the body face —
   * and nothing in a console is set large enough to tell two humanist sans
   * apart. The two faces differed by about a point and a half of width per
   * hundred pixels and by nothing a reader would name, so the second webfont
   * was a download that bought no identity.
   *
   * `display` stays as a token because the *role* is real: a wordmark, a hero,
   * a pane title and a legal page's headings want one voice and the interface
   * wants another, and keeping the name means that distinction can be given a
   * face again later without touching a call site. It just resolves to the
   * body face now, and the difference between display and interface is carried
   * by size, weight and tracking instead.
   */
  display: Platform.select({
    web: webStack(
      "Instrument Sans",
      "ui-sans-serif, system-ui, -apple-system, sans-serif",
    ),
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

/**
 * The type scale.
 *
 * ## Why this file did not have one, and what that cost
 *
 * Colour, radii, spacing and shadows were all tokenised here and type was not,
 * so every screen picked its own size. The result, counted across `features/`
 * and `app/`: **26 distinct font sizes**, drifting in half-points — 10, 10.5,
 * 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17 and up. That
 * is not a scale, it is a ramp with every rung on it, and it is the single
 * largest reason two panels built by two different hands never looked related.
 *
 * Nine sizes, integers only. Half-points were never a design decision; they
 * are what happens when somebody nudges a number until one screen looks right,
 * and they blur on any display that is not 2x.
 *
 * ## Two densities, one scale
 *
 * A phone is not this scale shrunk. `pointerType` and `touchType` are the same
 * nine roles at two sizes, and `typeFor(density)` picks one — the same shape as
 * `radii`'s pointer/phone split, which this file already argued for and which
 * was previously expressed as three lonely radius values.
 *
 * Note that `title` gets **smaller** on a phone, not larger: the measure it has
 * to fit into is roughly 342pt rather than 640, and a title that wraps to three
 * lines is not emphatic, it is in the way.
 */
export const pointerType = {
  /** Uppercase section labels, tracked +0.08em, weight 600. */
  label: 11,
  /** Counts, timestamps, paths, anything a row says about itself. */
  meta: 12,
  /** The default: tree rows, tabs, buttons, menu items, fields. */
  ui: 13,
  /** Settings prose, dialog bodies, empty states. */
  lede: 15,
  /** The note. Set against `layout.readingMeasureEm`. */
  body: 16,
  h3: 19,
  h2: 23,
  /** A note title. */
  title: 30,
  /** Marketing and first-run only; nothing in the console is this size. */
  display: 40,
} as const;

/**
 * The published website's scale — a different voice from the console's.
 *
 * A visitor reading somebody's site is reading, not operating an app, so the
 * body is 18 and the headings are serif and large (the approved public-site
 * spec). Only `features/site` and the `site` look of `NoteBody` draw from it;
 * nothing in the console does.
 */
export const siteType = {
  /** The footer line. */
  foot: 13,
  /** Code blocks and the smallest heading. */
  code: 14,
  /** The header menu. */
  nav: 15,
  /** Inline code inside an 18px line. */
  inlineCode: 15,
  h5: 16,
  /** The site's name, and the phone menu's rows. */
  name: 17,
  /** A page's prose. */
  body: 18,
  h3: 21,
  h2: 26,
  /** A page's heading on a phone, where 44 wraps a short title. */
  h1Phone: 36,
  /** A page's title, in Instrument Serif. */
  h1: 44,
} as const;

export type TypeScale = Readonly<Record<keyof typeof pointerType, number>>;

export const touchType: TypeScale = {
  label: 11,
  meta: 12,
  ui: 16,
  lede: 17,
  body: 17,
  h3: 20,
  h2: 22,
  title: 28,
  display: 46,
};

/**
 * The scale for a density.
 *
 * `compact` is the phone — see `features/app/frame.ts`, which owns the word.
 * The two wider densities are pointer densities and share one scale: a medium
 * window is a narrower desktop, not a larger phone.
 */
export function typeFor(density: "compact" | "medium" | "wide"): TypeScale {
  return density === "compact" ? touchType : pointerType;
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
