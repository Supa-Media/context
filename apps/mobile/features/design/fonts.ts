/**
 * Font loading — native.
 *
 * Web is the shipping surface today and loads Instrument Sans, JetBrains
 * Mono and Libron for note text, all from our own origin (see
 * `fonts.web.ts`). Native has no bundled
 * font binaries yet, so it renders in the platform default and this is a no-op
 * rather than a lie about having loaded something.
 *
 * When native ships, bundle both families as assets and load them here
 * with `expo-font`'s `loadAsync`; `tokens.fonts` already returns `undefined` on
 * native so the switch is a one-file change.
 */
export const FONT_STYLESHEET_ID = "context-fonts";

/** Instrument Sans and JetBrains Mono, from our own origin (`public/context-fonts.css`). */
export const FONT_STYLESHEET_HREF = "/context-fonts.css";

/**
 * Libron, the face note text is read in (`fonts.reading`), is not on Google
 * Fonts: its official web files are served from our own origin, unmodified,
 * with the OFL beside them (`public/libron.css`, `public/Libron-OFL.txt`).
 * Root-level paths on purpose: a customer's domain serves only one-segment
 * static files (`infra/router`'s `site.ts`), and a shared note can open there.
 */
export const LIBRON_STYLESHEET_ID = "context-libron";

export const LIBRON_STYLESHEET_HREF = "/libron.css";

/** Resolves immediately on native — there is nothing to fetch. */
export function ensureFontsLoaded(): void {
  // no-op
}
