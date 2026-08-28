/**
 * Is a `?code=` URL parameter ours to redeem as a sign-in code?
 *
 * `ConvexAuthProvider`, left unconfigured, says yes on every route — and that
 * default cost a session on every Dropbox connect: Dropbox redirects back to
 * `/connect/dropbox?code=…` with **its** code, the auth provider redeemed it
 * as a login code, verification answered `tokens: null`, and the client
 * stored the sign-out. A working session, wiped by a successful storage
 * connect. Reproduced live on 2026-08-28 by navigating a signed-in session
 * to `/connect/dropbox?code=FAKE`: both auth keys gone from localStorage.
 *
 * So: a code on a `/connect/…` route belongs to whatever is connecting —
 * never to auth. Everywhere else the default stands, because the invitation
 * flow depends on it (the emailed link lands with a `?code=` that really is
 * a sign-in code).
 *
 * The prefix is deliberately `/connect/`, not `/connect/dropbox`: the next
 * provider added under that prefix gets the same protection without anyone
 * re-finding this bug.
 */
export function shouldHandleAuthCode(pathname: string): boolean {
  return !pathname.startsWith("/connect/");
}

/**
 * The predicate `SupaConvexProvider` wants: zero-argument, evaluated when a
 * code is present. Reads the live URL, and answers `true` where there is no
 * URL to read (native has no `window.location`, and no Dropbox callback
 * either — the redirect origins are web-only).
 */
export function shouldHandleCodeHere(): boolean {
  if (typeof window === "undefined" || !window.location?.pathname) return true;
  return shouldHandleAuthCode(window.location.pathname);
}
