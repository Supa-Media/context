import { Linking } from "react-native";
import { isSafeRedirect } from "./redirectSafety";

/**
 * Hand the browser back to the AI client's redirect URI — native.
 *
 * This is the one navigation in the app that deliberately leaves it, so it is
 * not `router.replace`: Expo Router only knows about our own routes.
 */
export function leaveTo(url: string): void {
  if (!isSafeRedirect(url)) return;
  void Linking.openURL(url);
}
