import { Linking } from "react-native";
import { isSafeProviderLink } from "./openScheme";

/**
 * Open a provider's connect link — native.
 *
 * `Linking.openURL` handles both halves here: an `https` link goes to the
 * browser, a `cursor://` one to the app, and there is no tab to worry about.
 */
export function openProviderLink(href: string): void {
  if (!isSafeProviderLink(href)) return;
  void Linking.openURL(href);
}
