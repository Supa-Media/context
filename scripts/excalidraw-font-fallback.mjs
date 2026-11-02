/**
 * Excalidraw without its font CDN fallback.
 *
 * Excalidraw 0.18 builds every font face's `src` list as our own URL
 * (`EXCALIDRAW_ASSET_PATH`, `drawing-editor/assetPath.js`) followed, always,
 * by the same file on esm.sh (`ExcalidrawFontFace.createUrls`, pushing
 * `ASSETS_FALLBACK_URL`). The browser walks that list in order, so whenever
 * our copy is missing, the request goes to a third party at the moment
 * somebody opens their own drawing. That is the case for every face of
 * `Xiaolai`, which is deliberately not deployed (`drawingAssets.ts`), and for
 * any face a future version adds. It is also why the browser suite's
 * enforced `font-src` reports esm.sh for every face (CASA scan, CSP Medium,
 * `docs/decisions/testing/csp-candidate.md`, blocker 4).
 *
 * The package exposes no setting for this, so the bundle is changed as it is
 * built: the one statement that pushes the fallback URL is removed, and a
 * face whose own file is missing falls back to a system font, which is what
 * `drawingAssets.ts` already says happens. The match is exact and must be
 * found exactly once, so an upgrade that changes the code fails the build
 * instead of quietly shipping the fallback again.
 */

/** The fallback push in the minified production chunk: `r.push(new URL(n,jn.ASSETS_FALLBACK_URL)),`. */
const FALLBACK_PUSH = /\b[\w$]+\.push\(new URL\([\w$]+,[\w$]+\.ASSETS_FALLBACK_URL\)\),/g;

/** `source` without the fallback push; throws unless it was there exactly once. */
export function withoutFontCdnFallback(source) {
  const found = source.match(FALLBACK_PUSH) ?? [];
  if (found.length !== 1) {
    throw new Error(`expected Excalidraw's font CDN fallback exactly once, found it ${found.length} times`);
  }
  return source.replace(FALLBACK_PUSH, "");
}

/** An esbuild plugin applying it to the one Excalidraw file that defines the fallback. */
export function fontCdnFallbackPlugin() {
  let applied = 0;
  return {
    name: "excalidraw-font-cdn-fallback",
    setup(build) {
      build.onLoad({ filter: /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/].*\.js$/ }, async (args) => {
        const { readFile } = await import("node:fs/promises");
        const source = await readFile(args.path, "utf8");
        if (!source.includes("ASSETS_FALLBACK_URL")) return undefined;
        applied += 1;
        return { contents: withoutFontCdnFallback(source), loader: "js" };
      });
      build.onEnd((result) => {
        if (result.errors.length === 0 && applied !== 1) {
          throw new Error(`Excalidraw's font CDN fallback was removed from ${applied} files, not 1`);
        }
      });
    },
  };
}
