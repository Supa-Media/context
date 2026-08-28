import { isDropboxAuthorizeUrl } from "./dropbox";

/**
 * Hand the browser to Dropbox's consent screen — web.
 *
 * `window.location.assign` rather than RN-Web's `Linking.openURL`, which calls
 * `window.open(url, "_blank")` — a popup, and a blocked one, in the middle of
 * an OAuth flow that has to come back to *this* tab. The callback route reads
 * the session from this origin's storage, so a redirect landing in a tab the
 * browser opened for us is a redirect landing somewhere the person is not
 * looking. Same reasoning and the same split as `features/consent/leave.web.ts`.
 */
export function leaveForDropbox(url: string): void {
  if (!isDropboxAuthorizeUrl(url)) return;
  if (typeof window === "undefined") return;
  window.location.assign(url);
}
