import { isSafeRedirect } from "./redirectSafety";

/**
 * Hand the browser back to the AI client's redirect URI — web.
 *
 * `window.location.assign` rather than RN-Web's `Linking.openURL`, which calls
 * `window.open(url, "_blank")` — a popup, and a blocked one, at the end of an
 * OAuth flow whose whole job is to land the person back on the client's site.
 */
export function leaveTo(url: string): void {
  if (!isSafeRedirect(url)) return;
  if (typeof window === "undefined") return;
  window.location.assign(url);
}
