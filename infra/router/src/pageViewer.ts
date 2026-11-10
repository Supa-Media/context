/**
 * The page viewer: `/p/@slug/<path>.page.md`, the link Tex texts for a page.
 *
 * A page used to open through the app's `/note/…` link, which loads the whole
 * app before it asks for the note (owner, 2026-11-10: pages are "supposed to
 * open up seamlessly"). This answers a person with the viewer instead: one
 * small page from the web export (`apps/mobile/page-viewer/`, built by
 * `scripts/build-page-frame.mjs` into `/drawing-assets/viewer/`), which reads
 * the note with the browser's own sign-in and draws it in the sealed page
 * runtime. Nothing is looked up here: the address is only shape-checked, and
 * the same HTML is served for every page, so this can't tell anyone whether a
 * note exists. A crawler gets the note link's card (`noteLinkFrom`).
 *
 * The export's assets fall back to the app's `index.html` for a missing file,
 * so the body is checked to be the viewer's before it is served. Without it
 * (an export built before the viewer), the link goes to the app as before.
 * Decision: `docs/decisions/app-and-console/pages.md`, "A page link opens the page".
 */

import type { Env } from "./env";

export const PAGE_VIEWER_PREFIX = "/p/";
/**
 * Where the web export carries the viewer: its folder, because static assets
 * answer a path naming `index.html` with a redirect to the folder, which the
 * marker check would read as "no viewer here" and send every link to the app.
 */
export const PAGE_VIEWER_ASSET = "/drawing-assets/viewer/";
/** A marker only the viewer's page carries (`VIEWER_MARKER` in `scripts/build-page-frame.mjs`). */
const MARKER = '<div id="context-page-viewer"';

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * `/p/@slug/<path>.page.md` as `{ slug, path }`, or null. The grammar of the
 * viewer's own `pageAddressFrom` (`apps/mobile/page-viewer/viewerCore.ts`).
 */
export function pageViewerAddress(pathname: string): { slug: string; path: string } | null {
  const address = linkAddress(pathname);
  return address !== null && /\.page\.md$/i.test(address.path) ? address : null;
}

/** Any note `/p/@slug/<path>` names, page or not, or null. */
function linkAddress(pathname: string): { slug: string; path: string } | null {
  if (!pathname.startsWith(PAGE_VIEWER_PREFIX)) return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 3) return null;
  const handle = decode(segments[1]);
  if (handle === null || !handle.startsWith("@")) return null;
  const slug = handle.slice(1).toLowerCase();
  if (!SLUG.test(slug)) return null;
  const parts = segments.slice(2).map(decode);
  if (parts.some((part) => part === null || part === "" || part === "." || part === ".." || part.includes("/"))) return null;
  const path = (parts as string[]).join("/");
  return path.length > 1024 ? null : { slug, path };
}

/** The app's `/note/…` link for the same page: where an address the viewer can't serve goes. */
export function appLinkForPage(address: { slug: string; path: string } | null): string {
  if (address === null) return "/app";
  return `/note/@${encodeURIComponent(address.slug)}/${address.path.split("/").map(encodeURIComponent).join("/")}`;
}

function toApp(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}

export async function pageViewerResponse(request: Request, url: URL, env: Env): Promise<Response> {
  const address = pageViewerAddress(url.pathname);
  // A plain note has nothing to draw here: it opens in the app, at its own link.
  if (address === null || (request.method !== "GET" && request.method !== "HEAD") || !env.ASSETS) return toApp(appLinkForPage(linkAddress(url.pathname)));
  const asset = await env.ASSETS.fetch(new Request(`${url.origin}${PAGE_VIEWER_ASSET}`, { redirect: "manual" }));
  const body = asset.ok ? await asset.text() : "";
  if (!body.includes(MARKER)) return toApp(appLinkForPage(address));
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The same bytes for every page, and nothing about the note in them; still never kept by a shared cache.
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
