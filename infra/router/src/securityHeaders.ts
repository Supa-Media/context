/**
 * The browser hardening every response from a platform host carries.
 *
 * Context's own hosts (context.lc, tex.lc, staging) serve the app that shows
 * a person their notes and the mail, calendar and chat synced from Google.
 * Until this module, the app's documents went out with no HSTS, no framing
 * rule and no sniffing rule, which is the first thing a security assessment's
 * scanner reports (OWASP ASVS 14.4, the Google CASA checklist).
 *
 * - **HSTS**, a year, without `includeSubDomains`: every platform subdomain is
 *   served over HTTPS today, but that promise is the zone's to make for hosts
 *   this Worker never sees, so it is left to the Cloudflare zone setting.
 * - **Framing: same origin only.** The app frames its own pages (the drawing
 *   editor, diagrams, the landing editor) and nothing else frames it, so a
 *   clickjacking page on another origin gets a blank frame. Both the legacy
 *   header and CSP `frame-ancestors`, because browsers honour one or the other.
 * - **`nosniff`** and a referrer policy that never sends a path off-site.
 *
 * Headers a branch already set win: the preview cards' `no-referrer`, for one,
 * is stricter than the default here. Customer domains never pass through this:
 * their sites have a routing table and headers of their own (`site.ts`).
 */

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": "frame-ancestors 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/**
 * `response` with every header in `SECURITY_HEADERS` it does not already set.
 *
 * A WebSocket upgrade (101) is returned untouched: its `webSocket` does not
 * survive being copied into a new Response.
 */
export function withSecurityHeaders(response: Response): Response {
  if (response.status === 101) return response;
  const missing = Object.entries(SECURITY_HEADERS).filter(([name]) => !response.headers.has(name));
  if (missing.length === 0) return response;
  const hardened = new Response(response.body, response);
  for (const [name, value] of missing) hardened.headers.set(name, value);
  return hardened;
}
