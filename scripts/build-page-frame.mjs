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
 *    (the note's CSS is a stylesheet); pictures and our own two fonts only
 *    as `data:`; frames only `box.html` beside it. No fetch, no forms,
 *    nothing else.
 *  - `box.html`: one note's ```` ```box ```` code. Its own inline script and
 *    styles run, and it can load nothing at all, so whatever it is handed
 *    stays in it.
 *
 * Classic scripts, not modules: a sandboxed frame has an opaque origin, and a
 * module script from it is a CORS request a static host does not answer.
 */

import { build } from "esbuild";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "apps", "mobile", "page-frame");
const OUT = path.join(ROOT, "apps", "mobile", "public", "drawing-assets", "page");
/** The page viewer a page link opens (`/p/@slug/<path>`, `apps/mobile/page-viewer/`), served by the router. */
const VIEWER_SOURCE = path.join(ROOT, "apps", "mobile", "page-viewer");
const VIEWER_OUT = path.join(ROOT, "apps", "mobile", "public", "drawing-assets", "viewer");

export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'self'; base-uri 'none'; form-action 'none'";
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

/**
 * Context's own faces, Instrument Sans and JetBrains Mono (the app's, from
 * `@fontsource`, latin only), carried in the page as data: the frame's CSP
 * loads nothing, so a font can only arrive inside it.
 */
const FONTS = [
  ["Instrument Sans", "@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2", "400 700"],
  ["JetBrains Mono", "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2", "500"],
];

async function fontCss() {
  const faces = [];
  for (const [family, file, weight] of FONTS) {
    const bytes = await readFile(path.join(ROOT, "apps", "mobile", "node_modules", file));
    faces.push(`@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2")}`);
  }
  return faces.join("\n");
}

function pageHtml(fonts) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}" />
    <meta name="referrer" content="no-referrer" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Page</title>
    <style>${fonts}</style>
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

/**
 * The viewer's CSP. It talks to one host, the control plane it was built for,
 * and frames only the page runtime (the deployment's own copy, or the sites
 * domain's in production). Its one script is its own file.
 */
export function viewerCsp(convexUrl) {
  // A deployment's control plane, or a local one for development.
  const origin = /^(?:https:\/\/[a-z0-9.-]+|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)$/i.test(convexUrl) ? convexUrl : "";
  return (
    `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; ` +
    `connect-src ${origin === "" ? "'none'" : origin}; frame-src 'self' https://*.ctxlc.site; base-uri 'none'; form-action 'none'`
  );
}

/** A marker only the viewer's page carries, which the router checks before serving it. */
export const VIEWER_MARKER = '<div id="context-page-viewer"';

function viewerHtml(convexUrl) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${viewerCsp(convexUrl)}" />
    <meta name="referrer" content="no-referrer" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>Context</title>
    <style>
      :root{--bg:#FFFDF9;--ink:#1A1714;--muted:#635C52;--line:#E9E4DB;--accent:#2A45CF;color-scheme:light}
      @media (prefers-color-scheme: dark){:root{--bg:#191715;--ink:#F4F0E8;--muted:#A79F94;--line:#36312B;--accent:#8A9BF2;color-scheme:dark}}
      html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
      .bar{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;gap:12px;
        padding:calc(env(safe-area-inset-top,0px) + 10px) max(16px,env(safe-area-inset-right,0px)) 10px max(16px,env(safe-area-inset-left,0px));
        background:var(--bg);border-bottom:1px solid var(--line);font-size:13px}
      .bar b{font-weight:650;letter-spacing:-.01em}
      .bar a{color:var(--accent);font-weight:600;text-decoration:none}
      #status{padding:48px 16px;text-align:center;color:var(--muted)}
      .drawn #status{display:none}
      .frame{display:block;width:100%;height:100vh;border:0;background:transparent}
    </style>
  </head>
  <body>
    <div id="context-page-viewer" class="bar"><b>Context</b><a id="open" href="/app">Open in Context</a></div>
    <div id="status" role="status">Opening the page…</div>
    <div id="page"></div>
    <script src="/drawing-assets/viewer/viewer.js"></script>
  </body>
</html>
`;
}

/** The viewer, built for the control plane this export talks to (`EXPO_PUBLIC_CONVEX_URL`). */
async function buildViewer() {
  const convexUrl = (process.env.EXPO_PUBLIC_CONVEX_URL ?? "").replace(/\/$/, "");
  await rm(VIEWER_OUT, { recursive: true, force: true });
  await mkdir(VIEWER_OUT, { recursive: true });
  await build({
    entryPoints: [path.join(VIEWER_SOURCE, "viewer.ts")],
    bundle: true,
    format: "iife",
    minify: true,
    sourcemap: false,
    target: ["es2020"],
    define: { VIEWER_CONVEX_URL: JSON.stringify(convexUrl) },
    outfile: path.join(VIEWER_OUT, "viewer.js"),
    logLevel: "warning",
  });
  await writeFile(path.join(VIEWER_OUT, "index.html"), viewerHtml(convexUrl));
  const bytes = (await stat(path.join(VIEWER_OUT, "viewer.js"))).size;
  console.log(`built the page viewer: ${(bytes / 1024).toFixed(0)}KB of script${convexUrl === "" ? " (no EXPO_PUBLIC_CONVEX_URL: it hands every link to the app)" : ""}`);
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
  await writeFile(path.join(OUT, "index.html"), pageHtml(await fontCss()));
  await writeFile(path.join(OUT, "box.html"), boxHtml());
  const bytes = (await stat(path.join(OUT, "frame.js"))).size;
  console.log(`built the page runtime: ${(bytes / 1024).toFixed(0)}KB of script, into apps/mobile/public/drawing-assets/page`);
  await buildViewer();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  buildPageFrame().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
