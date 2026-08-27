/**
 * Whether a URL is something we are willing to navigate to.
 *
 * Its own module rather than living next to `leaveTo`, because `leaveTo` is
 * platform-split (`leave.ts` / `leave.web.ts`) and the two halves must not
 * import each other — on web, `./leave` resolves to `leave.web.ts`, so a
 * re-export would be a module importing itself.
 *
 * `https:` is the only scheme allowed for a hosted client, plus the custom app
 * schemes desktop and CLI clients register (`raycast://`, `cursor://`). What is
 * refused is the family that executes rather than navigates —`javascript:`,
 * `data:`, `vbscript:`, `file:` — and anything that will not parse as an
 * absolute URL at all.
 *
 * The URL this guards comes from our own backend, which built it from the
 * redirect URI the client registered at sign-up. The check runs anyway: a
 * navigation target that a remote party influenced is exactly the value you do
 * not hand to a navigation API on trust.
 *
 * It is no longer only the consent screen's: `console/clients/open*.ts` guards
 * the connect links with the same function. It stays here because this is where
 * it was needed first and moving it would churn four call sites for a filename
 * — but it is a general rule about navigation targets now, not a consent
 * detail, and a second copy of it anywhere is a bug. One already existed and
 * was weaker than this.
 */

const DANGEROUS_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
]);

export function isSafeRedirect(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const scheme = parsed.protocol.toLowerCase();
  if (DANGEROUS_SCHEMES.has(scheme)) return false;

  // `http:` is refused too: an authorization code in a query string over
  // cleartext is a code handed to whoever is on the wire. Loopback is the one
  // exception, because it is what every native-app OAuth client uses.
  if (scheme === "http:") {
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  }

  return true;
}
