import { Linking } from "react-native";
import { isGoogleAuthorizeUrl } from "./google";

export function leaveForGoogle(url: string): void {
  if (!isGoogleAuthorizeUrl(url)) return;
  void Linking.openURL(url);
}
