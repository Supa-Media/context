import { Linking } from "react-native";
import { isSafeRedirect } from "../../consent/redirectSafety";

/**
 * Open a provider's connect link — native.
 *
 * `Linking.openURL` handles both halves here: an `https` link goes to the
 * browser, a `cursor://` one to the app, and there is no tab to worry about.
 *
 * The `catch` is not decoration. On a phone with no Cursor installed, the
 * `cursor://` promise **rejects** — so without it the button is silently dead
 * and the only trace is an unhandled rejection in a log nobody is reading.
 * There is no in-app surface for this yet, so the swallow is deliberate and
 * named rather than accidental.
 */
export function openProviderLink(href: string): void {
  if (!isSafeRedirect(href)) return;
  Linking.openURL(href).catch(() => {
    // No handler for this scheme on this device. Nothing to say yet.
  });
}
