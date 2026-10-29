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
 * every plugin as inline script; the drawing editor's bundle
 * (`drawing-assets/editor/editor.js`, built from `@excalidraw/excalidraw`)
 * carries WebAssembly glue that builds functions with `new Function`.
 * Each has to move to a document this policy does not cover, or stop needing
 * it, first; `cspReport.test.ts` fails if the policy enforces before then.
 *
 * A report names URLs, and a URL can carry a note's path or a token, so the
 * log keeps origins and the directive only: never a path, a query, or the
 * sample of script text a browser may attach.
 */

import { isPluginSandboxPath, SANDBOX_POLICY } from "./pluginSandbox";

export const CSP_REPORT_PATH = "/_csp-report";

/** The web shell's inline scripts, by hash, in the order the shell has them. */
export const SHELL_SCRIPT_HASHES = [
  "sha256-+p42j0S/XRK9dBQV/QIKuA78k3f1xWDUZtUJtkUnraw=",
  "sha256-WdDumAGqjyCYC8GSuHcTrKM+J3LudTENffnuL4oTaVw=",
  "sha256-ARyvZ8XnRfx9fPB0hl4d0/OMeuJeyct7psw/aPkcjTo=",
];

/**
 * The style half, measured the same way before anything enforces it
 * (2026-10-29, the CASA ZAP scan's "CSP: style-src unsafe-inline"). The
 * candidate names no `'unsafe-inline'`:
 *
 *  - `'self'`: the app's stylesheets and self-hosted fonts.
 *  - The shell's two inline `<style>` blocks (`expo-reset`, `context-ground`),
 *    by hash, pinned to the file like the scripts above.
 *  - The empty string's hash. React Native Web makes its stylesheet as an
 *    empty `<style>` and fills it with `insertRule`
 *    (`react-native-web/dist/exports/StyleSheet/dom/index.js`), and CSSOM
 *    calls are not something CSP governs; only the element's own (empty) text
 *    is checked. Whether every browser checks it that way is what the reports
 *    are for.
 *
 * What it would still block, and the reports should show: a `<style>` whose
 * text is written by script, such as the live editor's
 * (`apps/mobile/features/console/files/liveEditorWeb/stylesheet.ts`, ours to
 * move to `insertRule` or an adopted sheet), and whatever a library adds.
 */
export const SHELL_STYLE_HASHES = [
  "sha256-+R/ZCHnQviXyQb4aRG+FfnYnvSs95Sh3781AvYd08wc=",
  "sha256-ZZNz8w0+kaEm4BQi7zaS01zUgbCdEZjHcS4cH8ArMUI=",
];
export const EMPTY_STYLE_HASH = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

/** Every host that may serve script, each for the reason above. */
export const SCRIPT_HOSTS = [
  "https://challenges.cloudflare.com",
  "https://static.cloudflareinsights.com",
  "https://static.ads-twitter.com",
  "https://connect.facebook.net",
];

export const SCRIPT_POLICY =
  `script-src 'self' ${SHELL_SCRIPT_HASHES.map((hash) => `'${hash}'`).join(" ")} ${SCRIPT_HOSTS.join(" ")} 'wasm-unsafe-eval'; ` +
  `style-src 'self' ${[...SHELL_STYLE_HASHES, EMPTY_STYLE_HASH].map((hash) => `'${hash}'`).join(" ")}; ` +
  "object-src 'none'; base-uri 'self'; " +
  `report-uri ${CSP_REPORT_PATH}`;

/**
 * The drawing editor's document (`/drawing-assets/editor/`) gets a report-only
 * policy of its own, so the app shell's script policy can enforce without it.
 *
 * The editor is a page of its own, framed by URL, never `srcdoc`, so it is
 * given its own policy rather than inheriting the shell's. Its bundle is
 * Excalidraw 0.18.1, whose WebAssembly font compressor (`woff2.wasm`) ships
 * Emscripten embind glue that builds two functions with `new Function`
 * (`editor.js`; `@excalidraw/excalidraw/dist/prod/chunk-EIO257PC.js`). No
 * Excalidraw setting removes that, so this one document allows
 * `'unsafe-eval'`, and the shell never does. Like the shell it has no
 * `'unsafe-inline'` script: its only inline block is a style, named by hash
 * (`pageHtml` in `scripts/build-drawing-editor.mjs`, which writes the page).
 */
export const EDITOR_PATH_PREFIX = "/drawing-assets/editor/";
export const EDITOR_STYLE_HASHES = ["sha256-fInPXTRE3c/KCdPESxq2HoZMsIp8mGnmHRluR4cSYts="];

export const EDITOR_POLICY =
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; " +
  `style-src 'self' ${[...EDITOR_STYLE_HASHES, EMPTY_STYLE_HASH].map((hash) => `'${hash}'`).join(" ")}; ` +
  "object-src 'none'; base-uri 'self'; " +
  `report-uri ${CSP_REPORT_PATH}`;

/**
 * The fetch directives a `default-src` candidate would set, measured in
 * report-only before anything enforces it (the CASA scan's "CSP: Wildcard
 * Directive": with no `default-src`, every fetch directive falls back to any
 * source). Each source is one the app is known to reach:
 *
 *  - connect: the control plane (its HTTP and sync origins, from
 *    `CONVEX_ORIGIN`, so no deployment name is written here), the MCP
 *    gateway, Sentry, Turnstile and the Cloudflare beacon. PostHog comes
 *    through our own `/ingest`.
 *  - frame: our own frames, Turnstile, and the page runtime on the sites
 *    domain (`pageFrame.ts`).
 *  - img, font, media, worker: our own files, plus `data:` and `blob:`,
 *    which the app builds pictures, fonts, recordings and workers from.
 *
 * Anything else the reports show (a picture from another site, an embed) is
 * a decision about that feature, not a host to add blind.
 */
export function fetchDirectives(convexOrigin: string | undefined): string {
  const control: string[] = [];
  try {
    if (convexOrigin) {
      const site = new URL(convexOrigin);
      const cloudHost = site.hostname.replace(/\.convex\.site$/, ".convex.cloud");
      control.push(site.origin, `https://${cloudHost}`, `wss://${cloudHost}`);
    }
  } catch {
    // A malformed origin adds nothing; the reports will say what is missing.
  }
  const connect = [
    "'self'",
    ...control,
    "https://mcp.context.lc",
    "wss://mcp.context.lc",
    "https://*.ingest.sentry.io",
    "https://*.ingest.us.sentry.io",
    "https://challenges.cloudflare.com",
    "https://cloudflareinsights.com",
  ];
  return [
    "default-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "frame-src 'self' https://challenges.cloudflare.com https://*.ctxlc.site",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
}

/**
 * The report-only policy a platform document at `pathname` is given. The
 * plugin sandbox's page reports against its own policy (`pluginSandbox.ts`),
 * which it also enforces; the console's would only report every plugin.
 */
export function reportOnlyPolicyFor(pathname: string, convexOrigin: string | undefined): string {
  if (isPluginSandboxPath(pathname)) return `${SANDBOX_POLICY}; report-uri ${CSP_REPORT_PATH}`;
  const scripts = pathname.startsWith(EDITOR_PATH_PREFIX) ? EDITOR_POLICY : SCRIPT_POLICY;
  return `${fetchDirectives(convexOrigin)}; ${scripts}`;
}

/** Larger than any real report; a bigger body is not read. */
const MAX_REPORT_BYTES = 16 * 1024;

export type CspViolation = { directive: string; blocked: string; page: string; document: string };

/**
 * Which of our documents a report came from, as a fixed class rather than a
 * path: the console, the drawing editor and the plugin sandbox each get a
 * policy of their own, so their reports have to be told apart before any of
 * them can enforce, and `page` is an origin only. A path can name a note or
 * a person (`/note/@acme/…`), so it is never logged; the class is one of the
 * words below or "none".
 */
function documentClass(value: unknown): string {
  if (typeof value !== "string" || value === "") return "none";
  // Chrome's legacy report names a `srcdoc` (or blank) frame's document as a
  // bare "about", which is not a URL; it still inherits its parent's policy.
  if (value === "about") return "about";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "unparsed";
  }
  if (url.protocol === "about:") return url.pathname === "srcdoc" ? "srcdoc" : "about";
  if (url.protocol !== "https:" && url.protocol !== "http:") return "other-scheme";
  const path = url.pathname;
  if (path.startsWith(EDITOR_PATH_PREFIX)) return "drawing-editor";
  if (isPluginSandboxPath(path)) return "plugin-sandbox";
  if (path.startsWith("/drawing-assets/page/") || path.startsWith("/_page/")) return "page-runtime";
  if (path.startsWith("/drawing-assets/")) return "drawing-assets";
  if (path === "/console" || path.startsWith("/console/")) return "console";
  if (path === "/note" || path.startsWith("/note/")) return "shared-note";
  return "shell";
}

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
    document: documentClass(body["document-uri"] ?? body.documentURL),
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
