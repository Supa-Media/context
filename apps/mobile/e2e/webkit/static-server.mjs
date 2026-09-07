#!/usr/bin/env node
/**
 * The static file server the WebKit suite runs against.
 *
 * `expo export --platform web` produces a single-page app (`app.config.js`'s
 * `web.output` is unset, which Expo Router reads as `"single"` — see
 * `docs/decisions/app-and-console.md`, "The web shell is `public/index.html`").
 * A plain static server 404s on `/e2e-fixture` because no such *file* exists —
 * only `index.html`, which client-side routing turns into that URL after it
 * loads. So this rewrites every request with no file extension to
 * `index.html`, the same rewrite EAS Hosting and every SPA host applies, and
 * serves the export's real files — including their real
 * `Content-Type` — for everything else.
 *
 * Zero dependencies, on purpose: `apps/mcp`'s header gives the reasoning this
 * borrows — a bundler or a static-file package is a bigger surface than the
 * dozen lines this needs, and `node:http`/`node:fs` are already there.
 *
 * Usage: `node static-server.mjs <export-dir> <port>`
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const [, , rootArg, portArg] = process.argv;
if (rootArg === undefined || portArg === undefined) {
  console.error("usage: node static-server.mjs <export-dir> <port>");
  process.exit(1);
}
const root = normalize(rootArg);
const port = Number.parseInt(portArg, 10);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** The export's own file, or `null` — never a path that escaped `root`. */
function fileFor(pathname) {
  const decoded = decodeURIComponent(pathname.split("?")[0] ?? "/");
  const candidate = normalize(join(root, decoded));
  // `normalize` collapses `..`, so a candidate that no longer starts with
  // `root` tried to walk out of the export directory.
  if (!candidate.startsWith(root + sep) && candidate !== root) return null;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

const server = createServer((req, res) => {
  const direct = fileFor(req.url ?? "/");
  const file = direct ?? join(root, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  createReadStream(file).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`static export served: http://127.0.0.1:${port}`);
});
