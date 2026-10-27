#!/usr/bin/env node
/**
 * Build the page runtime: the sealed frame a `.page.md` note is drawn in
 * (`apps/mobile/page-frame/`, decision `docs/decisions/app-and-console/pages.md`).
 *
 * Built beside the Mermaid frame by `build-drawing-editor.mjs`, for the same
 * reasons: it is a page of its own, loaded in an `<iframe sandbox="allow-scripts">`
 * without `allow-same-origin`, so it is served as files rather than bundled
 * into the console. The router also serves these same files on
 * `<handle>.ctxlc.site/_page/` (`infra/router/src/pageFrame.ts`), which is
 * where production loads them from.
 *
 * Two pages, each with its CSP in a meta tag so it holds wherever the files
 * are served from:
 *
 *  - `index.html`: our runtime. One script, ours (`'self'`); styles inline
 *    (the note's CSS is a stylesheet); pictures only as `data:`; frames only
 *    `box.html` beside it. No fetch, no fonts, no forms, nothing else.
 *  - `box.html`: one note's ```` ```box ```` code. Its own inline script and
 *    styles run, and it can load nothing at all, so whatever it is handed
 *    stays in it.
 *
 * Classic scripts, not modules: a sandboxed frame has an opaque origin, and a
 * module script from it is a CORS request a static host does not answer.
 */

import { build } from "esbuild";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "apps", "mobile", "page-frame");
const OUT = path.join(ROOT, "apps", "mobile", "public", "drawing-assets", "page");

export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; frame-src 'self'; base-uri 'none'; form-action 'none'";
export const BOX_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";

/** The runtime's own controls (comment button, threads), over the page's look. */
const CHROME_CSS = `
.pg-pop{position:absolute;z-index:20;background:var(--pg-surface);color:var(--pg-body);border:1px solid var(--pg-line);border-radius:12px;box-shadow:0 10px 30px -12px rgba(0,0,0,.35);padding:10px;width:min(320px,calc(100vw - 16px));font-size:14px}
.pg-comment-button{width:auto;padding:7px 12px;font:600 13px/1 inherit;font-family:inherit;color:var(--pg-accent);cursor:pointer}
.pg-pop textarea{width:100%;font:inherit;color:inherit;background:var(--pg-bg);border:1px solid var(--pg-line);border-radius:8px;padding:8px;resize:vertical}
.pg-pop-row{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
.pg-pop-row button{font:600 13px/1 inherit;font-family:inherit;border:1px solid var(--pg-line);background:none;color:var(--pg-body);border-radius:8px;padding:7px 11px;cursor:pointer}
.pg-pop-row .pg-primary{background:var(--pg-accent);border-color:var(--pg-accent);color:var(--pg-surface)}
.pg-msg{margin-bottom:8px;line-height:1.4}
.pg-msg b{display:block;color:var(--pg-ink);font-size:12px}
`;

function pageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}" />
    <meta name="referrer" content="no-referrer" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Page</title>
    <style id="tokens"></style>
    <style id="base"></style>
    <style>${CHROME_CSS}</style>
    <style id="user-css"></style>
  </head>
  <body>
    <main id="page" class="pg"></main>
    <script src="./frame.js"></script>
  </body>
</html>
`;
}

function boxHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${BOX_CSP}" />
    <meta name="referrer" content="no-referrer" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Box</title>
    <style>html,body{margin:0;padding:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}</style>
  </head>
  <body>
    <script src="./box.js"></script>
  </body>
</html>
`;
}

export async function buildPageFrame() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  for (const [entry, outfile] of [
    ["entry.js", "frame.js"],
    ["box.js", "box.js"],
  ]) {
    await build({
      entryPoints: [path.join(SOURCE, entry)],
      bundle: true,
      format: "iife",
      minify: true,
      sourcemap: false,
      target: ["es2020"],
      outfile: path.join(OUT, outfile),
      logLevel: "warning",
    });
  }
  await writeFile(path.join(OUT, "index.html"), pageHtml());
  await writeFile(path.join(OUT, "box.html"), boxHtml());
  const bytes = (await stat(path.join(OUT, "frame.js"))).size;
  console.log(`built the page runtime: ${(bytes / 1024).toFixed(0)}KB of script, into apps/mobile/public/drawing-assets/page`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  buildPageFrame().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
