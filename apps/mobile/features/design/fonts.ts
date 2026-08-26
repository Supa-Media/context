/**
 * Font loading — native.
 *
 * Web is the shipping surface today and pulls Onest / Instrument Sans /
 * JetBrains Mono from Google Fonts (see `fonts.web.ts`). Native has no bundled
 * font binaries yet, so it renders in the platform default and this is a no-op
 * rather than a lie about having loaded something.
 *
 * When native ships, bundle the three families as assets and load them here
 * with `expo-font`'s `loadAsync`; `tokens.fonts` already returns `undefined` on
 * native so the switch is a one-file change.
 */
export const FONT_STYLESHEET_ID = "context-fonts";

export const FONT_STYLESHEET_HREF =
  "https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700" +
  "&family=Instrument+Sans:wght@400;500;600" +
  "&family=JetBrains+Mono:wght@400;500&display=swap";

/** Resolves immediately on native — there is nothing to fetch. */
export function ensureFontsLoaded(): void {
  // no-op
}
