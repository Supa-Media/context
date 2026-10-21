import { isConsentUrl } from "./connectFlow";

/** Sends the person to the provider's consent screen, in the same tab. */
export function leaveForConsent(url: string): void {
  if (!isConsentUrl(url)) return;
  if (typeof window === "undefined") return;
  window.location.assign(url);
}
