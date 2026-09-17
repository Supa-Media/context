/**
 * Whether a URL is something we are willing to navigate to.
 *
 * Its own module rather than living next to `leaveTo`, because `leaveTo` is
 * platform-split (`leave.ts` / `leave.web.ts`) and the two halves must not
 * import each other — on web, `./leave` resolves to `leave.web.ts`, so a
 * re-export would be a module importing itself.
 *
 * **An allowlist, because a denylist here was a list of the attacks somebody
 * had already thought of.** `https:`, loopback `http:`, and the one custom app
 * scheme the client catalogue actually uses (`cursor://`) pass; everything else
 * is refused, including anything that will not parse as an absolute URL.
 *
 * It was a denylist of six names until 2026-09-17 — `javascript:`, `data:`,
 * `vbscript:`, `file:`, `blob:`, `about:` — under this same paragraph, which
 * described the allowlist. Measured, the code admitted `ms-msdt:`,
 * `search-ms:`, `intent:`, `smb:`, `jar:`, `view-source:`, `chrome:`, `ftp:`
 * and `ws:`. No caller ever handed it one, which is why that was a tightening
 * and not a hole: the gateway's `redirectUriIsAcceptable` already allowlists a
 * registered redirect URI to `https` and loopback, and the provider catalogue
 * is constants. The reason to close it anyway is that **this was the only one
 * of the app's five ways out that was not an allowlist or tighter** —
 * `safeHref` over a shared note's Markdown, `isGoogleAuthorizeUrl` and
 * `isDropboxAuthorizeUrl` over an exact origin, and `Landing`'s constants are
 * the other four.
 *
 * **Adding a client whose deep link uses a new scheme means adding it here**,
 * and forgetting is loud rather than silent: `clientProviders.test.ts` asserts
 * every link in `CLIENT_PROVIDERS` passes this function, so a new scheme fails
 * a test instead of shipping a button that does nothing. `raycast://` is named
 * in no catalogue entry today and is therefore not in the set — surface with no
 * caller is the thing the gateway's own validator refuses to add.
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

/**
 * Every scheme this app is willing to navigate to, and nothing else.
 *
 * `http:` is deliberately absent and handled below: it is allowed only on
 * loopback, which is a host rule rather than a scheme rule.
 */
const ALLOWED_SCHEMES = new Set(["https:", "cursor:"]);

export function isSafeRedirect(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const scheme = parsed.protocol.toLowerCase();

  // `http:` anywhere but loopback is refused: an authorization code in a query
  // string over cleartext is a code handed to whoever is on the wire. Loopback
  // is the one exception, because it is what every native-app OAuth client
  // uses.
  if (scheme === "http:") {
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  }

  return ALLOWED_SCHEMES.has(scheme);
}
