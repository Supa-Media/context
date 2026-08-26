/**
 * Font loading — web.
 *
 * `app/+html.tsx` already puts the Google Fonts `<link>` in the served HTML,
 * which is what avoids a flash of fallback type on a cold load. This module is
 * the belt to that pair of braces: `+html.tsx` only participates in Expo
 * Router's HTML generation, and a host that serves its own shell (or a future
 * embed) would otherwise get system type. Injecting from app code is idempotent
 * and costs one DOM query.
 */
export const FONT_STYLESHEET_ID = "context-fonts";

export const FONT_STYLESHEET_HREF =
  "https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700" +
  "&family=Instrument+Sans:wght@400;500;600" +
  "&family=JetBrains+Mono:wght@400;500&display=swap";

export function ensureFontsLoaded(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(FONT_STYLESHEET_ID)) return;

  const link = document.createElement("link");
  link.id = FONT_STYLESHEET_ID;
  link.rel = "stylesheet";
  link.href = FONT_STYLESHEET_HREF;
  document.head.appendChild(link);
}
