/**
 * The public website's one extra face: Instrument Serif, for headings.
 *
 * Only a published page draws in it, so it is not in the app's font link
 * (`design/fonts.web.ts`) and a console session never downloads it. The web
 * build injects its stylesheet when a page mounts; native has no webfont and
 * falls back to the platform serif.
 *
 * The stylesheet and its files are ours (`public/context-site-serif.css`,
 * `public/InstrumentSerif-OFL.txt`), not Google Fonts': Google's CSS differs
 * per browser, so it can never carry an integrity hash (the CASA scan's
 * missing-SRI finding, 2026-10-29). Root-level, because a website opens on
 * a customer's domain too, which serves one-segment static files only.
 */

import { Platform } from "react-native";

export const SITE_SERIF_STYLESHEET_ID = "context-site-serif";

export const SITE_SERIF_STYLESHEET_HREF = "/context-site-serif.css";

export const siteSerif = Platform.select({
  web: '"Instrument Serif", ui-serif, Georgia, serif',
  ios: "Georgia",
  default: "serif",
});

export function ensureSiteSerifLoaded(): void {
  if (Platform.OS !== "web" || typeof document === "undefined") return;
  if (document.getElementById(SITE_SERIF_STYLESHEET_ID)) return;
  const link = document.createElement("link");
  link.id = SITE_SERIF_STYLESHEET_ID;
  link.rel = "stylesheet";
  link.href = SITE_SERIF_STYLESHEET_HREF;
  document.head.appendChild(link);
}
