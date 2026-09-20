import { isGoogleAuthorizeUrl } from "./google";

export function leaveForGoogle(url: string): void {
  if (!isGoogleAuthorizeUrl(url)) return;
  if (typeof window === "undefined") return;
  window.location.assign(url);
}
