import { Linking } from "react-native";
import { isDropboxAuthorizeUrl } from "./dropbox";

/**
 * Hand the browser to Dropbox's consent screen — native.
 *
 * Not `router.replace`: Expo Router only knows about our own routes, and this
 * is a navigation that deliberately leaves the app. Same split, and the same
 * reasoning, as `features/consent/leave.ts`.
 *
 * The guard is not decoration — see `isDropboxAuthorizeUrl`.
 */
export function leaveForDropbox(url: string): void {
  if (!isDropboxAuthorizeUrl(url)) return;
  void Linking.openURL(url);
}
