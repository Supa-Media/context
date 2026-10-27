/**
 * The page runtime on the sites domain: `<handle>.ctxlc.site/_page/…`.
 *
 * A `.page.md` note is drawn by our page runtime in a sealed frame
 * (`apps/mobile/page-frame/`, decision
 * `docs/decisions/app-and-console/pages.md`). In production the app loads that
 * frame from the person's own `<handle>.ctxlc.site`, a different site from
 * context.lc, so the code that draws a page never shares a site with the
 * session it is drawn inside. What is served here is only the runtime's four
 * static files, the same bytes the web export carries at
 * `/drawing-assets/page/` (built by `scripts/build-page-frame.mjs`): no
 * workspace is looked up and no note is read, so it is answered for any label
 * before the site lookup, and a private note never reaches this host. The
 * note's words go into the frame from the app, by `postMessage`.
 *
 * The export's assets fall back to the app's own `index.html` for a missing
 * file (`not_found_handling: single-page-application`), and the console must
 * never be served on the sites domain, so each file is checked to be the
 * runtime's before it is returned.
 */

import type { Env } from "./env";

export const PAGE_FRAME_PREFIX = "/_page/";
/** Where the web export carries the runtime. */
export const PAGE_ASSETS_PREFIX = "/drawing-assets/page/";

/** The runtime's files, each with its type and a marker only that file carries. */
const FILES: Readonly<Record<string, { type: string; marker: string }>> = {
  "index.html": { type: "text/html; charset=utf-8", marker: '<main id="page"' },
  "box.html": { type: "text/html; charset=utf-8", marker: 'src="./box.js"' },
  "frame.js": { type: "text/javascript; charset=utf-8", marker: "context-page" },
  "box.js": { type: "text/javascript; charset=utf-8", marker: "context-page-box" },
};

/**
 * A runtime page that is framed inside the runtime's own sealed frame, whose
 * origin is opaque. `frame-ancestors 'self'` and `X-Frame-Options` can never
 * match an opaque ancestor, so the platform's framing rule
 * (`securityHeaders.ts`) would blank every box on a deployment's own copy.
 * The box's content is inert without the runtime's message, and its own CSP
 * lets it load nothing.
 */
export function isPageBoxPath(pathname: string): boolean {
  return pathname === `${PAGE_ASSETS_PREFIX}box.html` || pathname === `${PAGE_ASSETS_PREFIX}box`;
}

export function isPageFrameRequest(url: URL): boolean {
  return url.pathname.startsWith(PAGE_FRAME_PREFIX);
}

function plain(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff" },
  });
}

/** Fetch one export file, following the assets' own trailing-slash redirect once (`/x/index.html` → `/x/`). */
async function exportFile(env: Env, origin: string, path: string): Promise<Response | null> {
  if (!env.ASSETS) return null;
  let response = await env.ASSETS.fetch(new Request(`${origin}${path}`, { redirect: "manual" }));
  const location = response.headers.get("Location");
  if (response.status >= 300 && response.status < 400 && location !== null) {
    const next = new URL(location, origin);
    if (next.origin !== origin || !next.pathname.startsWith(PAGE_ASSETS_PREFIX)) return null;
    response = await env.ASSETS.fetch(new Request(next.href, { redirect: "manual" }));
  }
  return response;
}

export async function pageFrameResponse(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method not allowed\n");
  const name = url.pathname.slice(PAGE_FRAME_PREFIX.length);
  const file = Object.hasOwn(FILES, name) ? FILES[name] : null;
  if (file === null) return plain(404, "Not found\n");
  const response = await exportFile(env, url.origin, `${PAGE_ASSETS_PREFIX}${name}`);
  if (response === null || !response.ok) return plain(503, "The page runtime is not available right now.\n");
  const body = await response.text();
  if (!body.includes(file.marker)) return plain(503, "The page runtime is not available right now.\n");
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "Content-Type": file.type,
      "Cache-Control": "public, max-age=300",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
