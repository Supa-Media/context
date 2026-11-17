/**
 * A navigation that landed on Chrome's own error page is not a loaded site.
 *
 * `chromewebdata` and `chrome-error:` are what Chrome shows for `net::ERR_*`.
 * A document HTTP status on the real host, including a 403, is the site's
 * answer and is not one of these.
 */

const NET = /net::ERR_[A-Z0-9_]{1,60}/;

/** Why this address is a failed navigation, or null when it is a real page. `netError` is Chrome's `net::ERR_*` text. */
export function pageLoadFailure(href: unknown, netError = ""): string | null {
  const url = typeof href === "string" ? href : "";
  const net = NET.exec(netError)?.[0] ?? "";
  if (url.startsWith("chrome-error:") || url.startsWith("chrome://")) return net || "chrome error page";
  try {
    if (new URL(url).hostname === "chromewebdata") return net || "chrome error page";
  } catch {
    // Not a URL. An unset href is not by itself a Chrome error page.
  }
  return null;
}

/** The words a failed goto may show. A net error is kept; anything else stays the generic line. */
export function gotoFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const net = NET.exec(message)?.[0];
  if (net) return net;
  if (message === "chrome error page" || message.startsWith("chrome error page")) return message.slice(0, 180);
  return "that did not work on this page";
}

const PROXY_CONNECT = /net::ERR_(?:SOCKS|PROXY|TUNNEL)_/;

/** A residential proxy that never connected. A reset or a refused name is not one of these. */
export function proxyConnectFailure(reason: unknown): boolean {
  return typeof reason === "string" && PROXY_CONNECT.test(reason);
}
