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
 * Only `'self'` and Cloudflare Turnstile may serve script: PostHog's SDK comes
 * through our own `/ingest` (`analyticsIngest.ts`), and Stripe is a redirect,
 * not a script on our page.
 *
 * A report names URLs, and a URL can carry a note's path or a token, so the
 * log keeps origins and the directive only: never a path, a query, or the
 * sample of script text a browser may attach.
 */

export const CSP_REPORT_PATH = "/_csp-report";

export const SCRIPT_POLICY =
  "script-src 'self' https://challenges.cloudflare.com; " +
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
