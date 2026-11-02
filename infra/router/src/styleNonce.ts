/**
 * A style nonce minted for every app shell response, in the report-only
 * policy only (2026-10-29, the CASA scan's "CSP: style-src unsafe-inline").
 *
 * The shell's report-only `style-src` names no `'unsafe-inline'`
 * (`cspReport.ts`): the shell's own two inline styles are allowed by hash and
 * React Native Web's empty `<style>` by the empty hash. What it still refuses
 * is CodeMirror's theme, which `style-mod` writes into a `<style>` element of
 * its own. A nonce is the one way to let that element through, and the editor
 * already takes one: `liveEditorWeb/styleNonce.ts` reads it from the shell's
 * `<style id="context-ground">` and hands it to `EditorView.cspNonce`.
 *
 * So this puts one fresh nonce in three places of one response, the way the
 * browser suite's fixture does (`apps/mobile/e2e/webkit/csp-style-nonce.mjs`,
 * held to this by `styleNonce.test.ts`): the `nonce` attribute of the shell's
 * two inline styles, and `'nonce-…'` in the report-only `style-src`. Nothing
 * else in the document gets it, so an author's style in a `srcdoc` preview
 * is still refused. The enforced policy has no `style-src` and does not
 * change, so a person sees no difference; the reports show whether the
 * shell's `style-src-elem` rows are gone before anything enforces it.
 *
 * A nonce that repeats is no defence, so it is 128 random bits per response,
 * and a response that carries one must never be paired with another's:
 *
 *  - It is sent `no-cache` with no `ETag` and no `Last-Modified`, and the
 *    request reaches the assets binding without `If-None-Match` or
 *    `If-Modified-Since`. A 304 would keep a cached body's old nonce under
 *    this response's new header, and the shell would lose its own styles.
 *  - The service worker (`apps/mobile/public/sw.js`) stores the shell, header
 *    and body together, and replays it offline. It mints a new nonce on
 *    every replay, in the same places.
 *
 * Only the shell: the drawing editor and the page box are documents with
 * policies of their own, and a document without the two shell styles (a
 * renamed id, a page of another build) is served exactly as before, with no
 * nonce, rather than failing. `styleNonce.test.ts` reads the real
 * `public/index.html`, so a renamed id fails there instead.
 */

import { reportOnlyPolicyFor } from "./cspReport";
import { isPageBoxPath } from "./pageFrame";
import { isPluginSandboxPath } from "./pluginSandbox";

/** The shell's inline styles that carry the nonce (`apps/mobile/public/index.html`). */
export const NONCED_STYLE_IDS = ["expo-reset", "context-ground"] as const;

/** 128 random bits, base64. */
export function freshNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** `html` with `nonce` on each shell style, or `null` when the document is not the shell. */
export function withStyleNonce(html: string, nonce: string): string | null {
  let out = html;
  for (const id of NONCED_STYLE_IDS) {
    const tag = `<style id="${id}">`;
    if (!out.includes(tag)) return null;
    out = out.replace(tag, `<style id="${id}" nonce="${nonce}">`);
  }
  return out;
}

/**
 * `policy` with `'nonce-…'` added to its `style-src`, or `null` when there is
 * none to add it to, or when that `style-src` allows `'unsafe-inline'`: a
 * browser ignores `'unsafe-inline'` once a nonce is present, so adding one
 * there would quietly switch off every other inline style it allowed.
 */
export function policyWithNonce(policy: string, nonce: string): string | null {
  let added = false;
  const out = policy.split(";").map((directive) => {
    const trimmed = directive.trim();
    if (trimmed.split(/\s+/)[0] !== "style-src") return directive;
    if (trimmed.includes("'unsafe-inline'")) return null;
    added = true;
    return ` ${trimmed} 'nonce-${nonce}'`;
  });
  if (!added || out.includes(null)) return null;
  return out.join(";").trim();
}

/** Whether a request at `pathname` may be answered with the shell document. */
function mayBeShell(request: Request, pathname: string): boolean {
  if (request.method !== "GET") return false;
  if (pathname.startsWith("/drawing-assets/") || isPageBoxPath(pathname) || isPluginSandboxPath(pathname)) return false;
  const dest = request.headers.get("Sec-Fetch-Dest");
  if (dest === "document" || dest === "iframe" || dest === "frame") return true;
  return (request.headers.get("Accept") ?? "").includes("text/html");
}

/**
 * The assets binding's answer to `request`, with a fresh style nonce when it
 * is the shell. Anything else, the shell's own JavaScript and pictures
 * included, is the binding's response untouched.
 */
export async function assetsWithStyleNonce(
  request: Request,
  assets: Fetcher,
  pathname: string,
  convexOrigin: string | undefined,
): Promise<Response> {
  if (!mayBeShell(request, pathname)) return assets.fetch(request);
  const unconditional = new Request(request);
  unconditional.headers.delete("If-None-Match");
  unconditional.headers.delete("If-Modified-Since");
  const response = await assets.fetch(unconditional);
  if (response.status !== 200 || !(response.headers.get("Content-Type") ?? "").startsWith("text/html")) return response;
  const html = await response.text();
  const nonce = freshNonce();
  const body = withStyleNonce(html, nonce);
  const policy = policyWithNonce(reportOnlyPolicyFor(pathname, convexOrigin), nonce);
  const headers = new Headers(response.headers);
  // The body is read and written again: its length and encoding describe the bytes as they came.
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  if (body === null || policy === null) return new Response(html, { status: 200, statusText: response.statusText, headers });
  headers.delete("ETag");
  headers.delete("Last-Modified");
  headers.set("Cache-Control", "no-cache");
  // Set here, so `withSecurityHeaders` keeps it rather than writing the policy without the nonce.
  headers.set("Content-Security-Policy-Report-Only", policy);
  return new Response(body, { status: 200, statusText: response.statusText, headers });
}
