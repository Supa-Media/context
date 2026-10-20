/**
 * `context.lc/download/mac`: the one address that always means "the newest Mac
 * app", for the homepage footer and for anyone who shares the link.
 *
 * It answers with a temporary redirect to GitHub's own "latest release" URL
 * for a dmg whose name carries no version (`apps/desktop/electron-builder.yml`
 * names it `Context-mac-<arch>.dmg`), so a new release needs no change here and
 * the redirect never goes stale. A 302 with no edge caching, never a 301: a
 * permanent redirect is remembered by browsers, and the day the dmg moves
 * somewhere other than GitHub this address has to move with it.
 *
 * `/download/mac` is Apple silicon, which every Mac sold since 2023 is;
 * `/download/mac/intel` is the x64 build for the Macs before it. A browser
 * cannot tell the two apart (Safari on Apple silicon still says "Intel"), so
 * the default is the one nearly everybody has.
 */

export const DOWNLOAD_RELEASES = "https://github.com/Supa-Media/context/releases/latest/download";

const DOWNLOADS: Readonly<Record<string, string>> = {
  "/download/mac": `${DOWNLOAD_RELEASES}/Context-mac-arm64.dmg`,
  "/download/mac/intel": `${DOWNLOAD_RELEASES}/Context-mac-x64.dmg`,
};

/** The dmg an address names, or null. Exact paths only; a trailing slash is tolerated. */
export function downloadFor(pathname: string): string | null {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return Object.hasOwn(DOWNLOADS, path) ? DOWNLOADS[path] : null;
}

/** Temporary and uncached, unlike the Worker's host redirect: the address is ours to repoint. */
export function downloadResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}
