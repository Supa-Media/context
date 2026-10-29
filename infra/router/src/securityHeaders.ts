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
 * - **The enforced policy's other directives** (2026-10-29, the CASA ZAP
 *   scan's "Failure to Define Directive with No Fallback"): `form-action
 *   'self'`, `object-src 'none'` and `base-uri 'self'`, none of which falls
 *   back to `default-src`. Each is enforced because the source shows nothing
 *   on these hosts needs more: every `<form>` in the app calls
 *   `preventDefault` and submits by `fetch`, sign-in and checkout leave by
 *   redirect, and nothing creates an `<object>`, an `<embed>` or a `<base>`.
 *   Frames of ours that write their own policy keep theirs, which is
 *   stricter (`'none'`), since a document obeys every policy it is given.
 *   Script and style stay report-only (`cspReport.ts`) until the frames that
 *   need inline script and `new Function` move out from under them.
 *
 * Headers a branch already set win: the preview cards' `no-referrer`, for one,
 * is stricter than the default here. Customer domains never pass through this:
 * their sites have a routing table and headers of their own (`site.ts`).
 */

import { SCRIPT_POLICY } from "./cspReport";
import { isPageBoxPath } from "./pageFrame";

/** What the enforcing header allows: no directive here may block a script or a style. */
export const ENFORCED_POLICY = "frame-ancestors 'self'; form-action 'self'; object-src 'none'; base-uri 'self'";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": ENFORCED_POLICY,
  // Report-only until its reports are quiet; see cspReport.ts.
  "Content-Security-Policy-Report-Only": SCRIPT_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/**
 * The headers left off the page box: the two that say who may frame a
 * response, and the script policy, whose `'self'` an opaque origin never is.
 */
const FRAMING = new Set(["X-Frame-Options", "Content-Security-Policy", "Content-Security-Policy-Report-Only"]);

/**
 * `response` with every header in `SECURITY_HEADERS` it does not already set.
 *
 * The framing rule is left off the one static file framed by a sealed frame
 * of our own (a page's box, `isPageBoxPath` in `pageFrame.ts`, found by the
 * request's `pathname`): its ancestor has an opaque origin, which neither
 * header can ever match.
 *
 * A WebSocket upgrade (101) is returned untouched: its `webSocket` does not
 * survive being copied into a new Response.
 */
export function withSecurityHeaders(response: Response, pathname = ""): Response {
  if (response.status === 101) return response;
  const framable = isPageBoxPath(pathname);
  const missing = Object.entries(SECURITY_HEADERS).filter(([name]) => !response.headers.has(name) && !(framable && FRAMING.has(name)));
  if (missing.length === 0) return response;
  const hardened = new Response(response.body, response);
  for (const [name, value] of missing) hardened.headers.set(name, value);
  return hardened;
}
