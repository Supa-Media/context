import { Linking } from "react-native";
import { isConsentUrl } from "./connectFlow";

/** Sends the person to the provider's consent screen, in the same browser. */
export function leaveForConsent(url: string): void {
  if (!isConsentUrl(url)) return;
  void Linking.openURL(url);
}
