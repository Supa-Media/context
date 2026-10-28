/**
 * The app's script policy, in report-only mode, and the address its reports
 * come back to.
 *
 * An XSS on context.lc would reach the sign-in tokens the web app keeps in
 * `localStorage`, and through them the person's synced mail. A script
 * Content-Security-Policy is the defence (OWASP ASVS 14.4.3, the CASA scan's
 * "CSP not set"), but the app has never run under one, so enforcing it blind
 * could blank the app for everyone. It ships as `Content-Security-Policy-
 * Report-Only` first: browsers run every script as before and post what the
 * policy would have blocked to `/_csp-report`, which logs it. Once those logs
 * are quiet the same policy moves to the enforcing header.
 *
 * What may run is what the first day of reports (2026-10-28, 79 of them)
 * showed the app needs, and nothing more:
 *
 *  - `'self'`, and Cloudflare Turnstile for sign-in.
 *  - The web shell's three inline scripts (`apps/mobile/public/index.html`: the
 *    appearance read before first paint, and the X and Meta pixel snippets),
 *    each by its SHA-256, never `'unsafe-inline'`. Editing one changes its
 *    hash, and `cspReport.test.ts` fails until the hash here is updated.
 *  - Cloudflare Web Analytics' beacon, which Cloudflare adds to the page.
 *  - The X and Meta pixels' own scripts, which the shell loads on context.lc's
 *    landing page only.
 *  - `'wasm-unsafe-eval'`: compiling WebAssembly, which the app does. It
 *    allows no JavaScript `eval`.
 *
 * PostHog's SDK comes through our own `/ingest` (`analyticsIngest.ts`), and
 * Stripe is a redirect, not a script on our page.
 *
 * Quiet reports are not enough to enforce it. Two frames of ours run script
 * this policy blocks, and only when someone uses them, so a quiet hour says
 * nothing about them: the plugin sandbox (`packages/obsidian-runtime`) is a
 * `srcdoc` document, which inherits this policy, and runs its bootstrap and
 * every plugin as inline script; the drawing editor's bundled WebAssembly glue
 * (`drawing-assets/editor/editor.js`) builds functions with `new Function`.
 * Each has to move to a document this policy does not cover, or stop needing
 * it, first; `cspReport.test.ts` fails if the policy enforces before then.
 *
 * A report names URLs, and a URL can carry a note's path or a token, so the
 * log keeps origins and the directive only: never a path, a query, or the
 * sample of script text a browser may attach.
 */

export const CSP_REPORT_PATH = "/_csp-report";

/** The web shell's inline scripts, by hash, in the order the shell has them. */
export const SHELL_SCRIPT_HASHES = [
  "sha256-+p42j0S/XRK9dBQV/QIKuA78k3f1xWDUZtUJtkUnraw=",
  "sha256-WdDumAGqjyCYC8GSuHcTrKM+J3LudTENffnuL4oTaVw=",
  "sha256-ARyvZ8XnRfx9fPB0hl4d0/OMeuJeyct7psw/aPkcjTo=",
];

/** Every host that may serve script, each for the reason above. */
export const SCRIPT_HOSTS = [
  "https://challenges.cloudflare.com",
  "https://static.cloudflareinsights.com",
  "https://static.ads-twitter.com",
  "https://connect.facebook.net",
];

export const SCRIPT_POLICY =
  `script-src 'self' ${SHELL_SCRIPT_HASHES.map((hash) => `'${hash}'`).join(" ")} ${SCRIPT_HOSTS.join(" ")} 'wasm-unsafe-eval'; ` +
  "object-src 'none'; base-uri 'self'; " +
  `report-uri ${CSP_REPORT_PATH}`;

/** Larger than any real report; a bigger body is not read. */
const MAX_REPORT_BYTES = 16 * 1024;

export type CspViolation = { directive: string; blocked: string; page: string };

/** `blocked-uri` reduced to what is safe to log: an origin or a keyword. */
function originOnly(value: unknown): string {
  if (typeof value !== "string" || value === "") return "none";
  if (/^(inline|eval|wasm-eval|trusted-types-policy|trusted-types-sink|self|data|blob)$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "data:" || url.protocol === "blob:") return url.protocol.slice(0, -1);
    return url.origin === "null" ? url.protocol.slice(0, -1) : url.origin;
  } catch {
    return "unparsed";
  }
}

function directiveOf(value: unknown): string {
  return typeof value === "string" && /^[a-z-]{1,40}$/.test(value) ? value : "unknown";
}

/**
 * The violations in a report body: the legacy `{"csp-report": {...}}` shape
 * and the Reporting API's array of `{type, body}` both, reduced by
 * `originOnly`. Anything else is no violations.
 */
export function parseCspReport(text: string): CspViolation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const bodies: Record<string, unknown>[] = [];
  if (Array.isArray(parsed)) {
    for (const entry of parsed.slice(0, 20)) {
      if (entry && typeof entry === "object" && (entry as { type?: unknown }).type === "csp-violation") {
        const body = (entry as { body?: unknown }).body;
        if (body && typeof body === "object") bodies.push(body as Record<string, unknown>);
      }
    }
  } else if (parsed && typeof parsed === "object") {
    const legacy = (parsed as Record<string, unknown>)["csp-report"];
    if (legacy && typeof legacy === "object") bodies.push(legacy as Record<string, unknown>);
  }
  return bodies.map((body) => ({
    directive: directiveOf(body["effective-directive"] ?? body.effectiveDirective ?? body["violated-directive"]),
    blocked: originOnly(body["blocked-uri"] ?? body.blockedURL),
    page: originOnly(body["document-uri"] ?? body.documentURL),
  }));
}

/** `POST /_csp-report`: log each violation, answer 204, never echo the body. */
export async function cspReportResponse(request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > MAX_REPORT_BYTES) return new Response(null, { status: 413 });
  const text = (await request.text()).slice(0, MAX_REPORT_BYTES);
  for (const violation of parseCspReport(text)) {
    console.log(JSON.stringify({ event: "csp_report_only_violation", ...violation }));
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
