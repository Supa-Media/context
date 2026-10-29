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
 *
 * With `E2E_CSP_RULES` set (`csp-candidate.ts` writes it, only when
 * `E2E_CSP_CANDIDATE` names a mode), every response carries the headers of the
 * longest matching rule, as much of the router's report-only policy enforced
 * as the mode asks,
 * and `POST /_csp-report` appends one line per violation to `E2E_CSP_REPORTS`:
 * the directive, the blocked source's origin or keyword, and the document's
 * class. Without it the server sends no security headers at all, as before.
 */
import { appendFileSync, createReadStream, existsSync, readFileSync, statSync } from "node:fs";
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

const rules = process.env.E2E_CSP_RULES
  ? JSON.parse(readFileSync(process.env.E2E_CSP_RULES, "utf8")).sort((a, b) => b.prefix.length - a.prefix.length)
  : null;
const reportLog = process.env.E2E_CSP_REPORTS ?? null;

function ruleFor(pathname) {
  return rules?.find((rule) => pathname.startsWith(rule.prefix)) ?? null;
}

/** An origin or a CSP keyword, never a path or a query. */
function sourceOf(value) {
  if (typeof value !== "string" || value === "") return "none";
  if (/^[a-z-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    return url.origin === "null" ? `${url.protocol}` : url.origin;
  } catch {
    return "unparsed";
  }
}

function documentOf(value) {
  if (typeof value !== "string" || value === "") return "none";
  // Chrome's legacy report names a `srcdoc` frame's document as bare "about".
  if (value === "about" || value.startsWith("about:")) return "srcdoc-or-about";
  try {
    return ruleFor(new URL(value).pathname)?.document ?? "unmatched";
  } catch {
    return "unparsed";
  }
}

/** Both report formats: the legacy `{"csp-report": …}` and the Reporting API's array. */
function recordReports(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  const bodies = Array.isArray(parsed) ? parsed.map((entry) => entry?.body).filter(Boolean) : [parsed?.["csp-report"]].filter(Boolean);
  for (const body of bodies) {
    const line = {
      document: documentOf(body["document-uri"] ?? body.documentURL),
      directive: body["effective-directive"] ?? body.effectiveDirective ?? body["violated-directive"] ?? "unknown",
      blocked: sourceOf(body["blocked-uri"] ?? body.blockedURL),
      disposition: body.disposition ?? "enforce",
    };
    appendFileSync(reportLog, `${JSON.stringify(line)}\n`);
  }
}

const server = createServer((req, res) => {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  if (reportLog !== null && req.method === "POST" && pathname === "/_csp-report") {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (text.length < 16 * 1024) text += chunk;
    });
    req.on("end", () => {
      recordReports(text);
      res.writeHead(204).end();
    });
    return;
  }
  for (const [name, value] of Object.entries(ruleFor(pathname)?.headers ?? {})) res.setHeader(name, value);
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
