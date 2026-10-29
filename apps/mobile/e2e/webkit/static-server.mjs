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
 * longest matching rule, with as much of the router's report-only policy
 * enforced as the mode asks, and `POST /_csp-report` appends one line per
 * violation to `E2E_CSP_REPORTS`, bounded by `csp-report-log.mjs` to the same
 * schema the router logs. With `E2E_CSP_NONCE=1` too, every shell document
 * gets a fresh style nonce (`csp-style-nonce.mjs`). Without rules the server
 * sends no security headers at all, as before.
 */
import { appendFileSync, createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { extname, join, normalize, sep } from "node:path";
import { reportLines } from "./csp-report-log.mjs";
import { freshNonce, policyWithNonce, withStyleNonce } from "./csp-style-nonce.mjs";

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
// A fresh style nonce on every shell document (`csp-style-nonce.mjs`); only with rules.
const nonceShell = rules !== null && process.env.E2E_CSP_NONCE === "1";

function ruleFor(pathname) {
  return rules?.find((rule) => pathname.startsWith(rule.prefix)) ?? null;
}

/** Each violation as `csp-report-log.mjs` bounds it: classes, keywords and origins only. */
function recordReports(text, disposition) {
  const classify = (pathname) => ruleFor(pathname)?.document ?? "unmatched";
  for (const line of reportLines(text, classify, disposition)) appendFileSync(reportLog, `${JSON.stringify(line)}\n`);
}

/** Where each policy reports (`csp-candidate.ts`): the router's report-only one, and the candidate's enforced copy. */
const REPORT_ADDRESSES = { "/_csp-report": "report", "/_csp-report/enforce": "enforce" };

/*
  With `E2E_TLS_KEY` and `E2E_TLS_CERT` (a throwaway self-signed pair the
  Playwright config makes for one run, `E2E_HTTPS=1`), the same server
  answers over HTTPS, so a spec sees the app on a secure origin as
  production does.
*/
const tls =
  process.env.E2E_TLS_KEY && process.env.E2E_TLS_CERT
    ? { key: readFileSync(process.env.E2E_TLS_KEY), cert: readFileSync(process.env.E2E_TLS_CERT) }
    : null;

const handle = (req, res) => {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  if (reportLog !== null && req.method === "POST" && Object.hasOwn(REPORT_ADDRESSES, pathname)) {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (text.length < 16 * 1024) text += chunk;
    });
    req.on("end", () => {
      recordReports(text, REPORT_ADDRESSES[pathname]);
      res.writeHead(204).end();
    });
    return;
  }
  const rule = ruleFor(pathname);
  const direct = fileFor(req.url ?? "/");
  const file = direct ?? join(root, "index.html");
  if (!existsSync(file)) {
    for (const [name, value] of Object.entries(rule?.headers ?? {})) res.setHeader(name, value);
    res.writeHead(404).end("not found");
    return;
  }
  if (nonceShell && rule?.document === "shell" && file === join(root, "index.html")) {
    const nonce = freshNonce();
    for (const [name, value] of Object.entries(rule.headers)) {
      const policy = (one) => (/^content-security-policy/i.test(name) ? policyWithNonce(one, nonce) : one);
      res.setHeader(name, Array.isArray(value) ? value.map(policy) : policy(value));
    }
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[".html"], "Cache-Control": "no-cache" });
    res.end(withStyleNonce(readFileSync(file, "utf8"), nonce));
    return;
  }
  for (const [name, value] of Object.entries(rule?.headers ?? {})) res.setHeader(name, value);
  const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  createReadStream(file).pipe(res);
};

const server = tls === null ? createHttpServer(handle) : createHttpsServer(tls, handle);

server.listen(port, "127.0.0.1", () => {
  console.log(`static export served: ${tls === null ? "http" : "https"}://127.0.0.1:${port}`);
});
