import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { candidateRules, ENFORCED_REPORT_PATH, REPORT_PATH } from "./csp-candidate";

/**
 * Which part of the diagram page's real delivery makes WebKit refuse its
 * `frame.js` under the enforcing `script-src` candidate?
 *
 * `cspOpaqueSelf.spec.ts` showed it is not `'self'` in an opaque-origin frame
 * as such: a header `'self'` runs there in WebKit too. So this rebuilds the
 * real frame one difference at a time, every frame `sandbox="allow-scripts"`
 * with `referrerpolicy="no-referrer"`, exactly as `livePreview/diagram.ts`
 * makes it, and served by `page.route` so nothing but the variable changes:
 *
 *  - headers: a bare `script-src 'self'`; the candidate's enforced copy for
 *    this path alone (the router's `script-src`, hashes and hosts included);
 *    every header the candidate sends for this path, the platform policy, the
 *    enforced copy and the report-only policy together; or production's
 *    headers alone, without the enforced copy;
 *  - origin: `https://context.test`, or the fixture's own
 *    `http://127.0.0.1:4874`;
 *  - page: a minimal one, or the shipped `index.html` with its meta policy;
 *  - script: a one-line marker, or the shipped `frame.js`, which says
 *    `ready` when it runs.
 *
 * And one bridge back to the failing case: the shipped page and script from
 * the fixture's own static server, unrouted, with the headers it really sends
 * (each policy on a header line of its own). Only the host page and the
 * report sink are routed there, so this spec's reports never reach the run's
 * candidate log.
 *
 * Every frame's outcome is an annotation and one console line, and every
 * report is counted by the address it went to (enforced copy or report-only),
 * never by its content. The spec then expects every frame to have run, so a
 * failing run names exactly the frames that did not.
 */

const HERE = __dirname;
/** The shipped page and script, from the export the fixture serves (`playwright.config.ts`); they are built, not committed. */
const DIAGRAM = join(process.env.E2E_WEB_EXPORT_DIR ?? join(HERE, "..", "..", "web-build"), "drawing-assets", "diagram");
const PAGE = readFileSync(join(DIAGRAM, "index.html"), "utf8");
const SCRIPT = readFileSync(join(DIAGRAM, "frame.js"), "utf8");
const MINIMAL = '<!doctype html><html><head></head><body><script src="./frame.js"></script></body></html>';
const MARKER = "parent.postMessage({ channel: 'context-diagram', type: 'ready' }, '*');";

const rule = candidateRules("script").find((candidate) => candidate.prefix === "/drawing-assets/diagram/");
if (rule === undefined) throw new Error("the candidate has no rule for the diagram page");
const enforcing = rule.headers["content-security-policy"];
if (!Array.isArray(enforcing) || enforcing.length !== 2) throw new Error("the diagram rule has no enforced copy");
const [platform, enforcedCopy] = enforcing as [string, string];

/** Header sets, by name. A list of policies is sent as one comma-joined header, which is the same policies to a browser. */
const HEADERS: Record<string, Record<string, string>> = {
  "bare-self": { "content-security-policy": "script-src 'self'" },
  "candidate-copy": { "content-security-policy": enforcedCopy },
  "candidate-all": {
    ...stringHeaders(rule.headers),
    "content-security-policy": `${platform}, ${enforcedCopy}`,
  },
  "production-only": { ...stringHeaders(rule.headers), "content-security-policy": platform },
};

function stringHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

const ORIGINS = { https: "https://context.test", fixture: "http://127.0.0.1:4874" } as const;

type Variant = { name: string; headers: string; page: "minimal" | "shipped"; script: "marker" | "shipped" };

const VARIANTS: Variant[] = Object.keys(HEADERS).flatMap((headers) =>
  (["minimal", "shipped"] as const).flatMap((page) =>
    (["marker", "shipped"] as const).map((script) => ({ name: `${headers}.${page}-page.${script}-script`, headers, page, script })),
  ),
);

/** Serve `origin`: a host page, each variant under `/v/<name>/`, and a report sink that keeps counts only. */
async function serve(page: Page, origin: string, reports: Map<string, number>): Promise<void> {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (request.method() === "POST" && (url.pathname === REPORT_PATH || url.pathname === ENFORCED_REPORT_PATH)) {
      const address = url.pathname === ENFORCED_REPORT_PATH ? "enforce" : "report";
      const body = request.postData() ?? "";
      const variant = VARIANTS.find((v) => body.includes(`/v/${v.name}/`));
      const key = `${variant?.name ?? "unattributed"}:${address}`;
      reports.set(key, (reports.get(key) ?? 0) + 1);
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.pathname === "/host") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>host</title>" });
    const match = /^\/v\/([^/]+)\/(index\.html|frame\.js)$/.exec(url.pathname);
    const variant = VARIANTS.find((v) => v.name === match?.[1]);
    if (match === null || variant === undefined) return route.abort();
    if (match[2] === "frame.js") {
      return route.fulfill({ contentType: "text/javascript", body: variant.script === "marker" ? MARKER : SCRIPT });
    }
    return route.fulfill({
      contentType: "text/html",
      headers: HEADERS[variant.headers],
      body: variant.page === "minimal" ? MINIMAL : PAGE,
    });
  });
}

/** Which variants' script said `ready`, by name. */
async function ranIn(page: Page, origin: string): Promise<Record<string, boolean>> {
  await page.goto(`${origin}/host`);
  return page.evaluate(async (names: string[]) => {
    const frames = new Map<Window, string>();
    const seen = new Set<string>();
    addEventListener("message", (event) => {
      const data = event.data as { channel?: unknown; type?: unknown } | null;
      const name = event.source === null ? undefined : frames.get(event.source as Window);
      if (name !== undefined && data && data.channel === "context-diagram" && data.type === "ready") seen.add(name);
    });
    for (const name of names) {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("src", `/v/${name}/index.html`);
      document.body.append(frame);
      if (frame.contentWindow !== null) frames.set(frame.contentWindow, name);
    }
    await new Promise((resolve) => setTimeout(resolve, 6000));
    return Object.fromEntries(names.map((name) => [name, seen.has(name)]));
  }, VARIANTS.map((variant) => variant.name));
}

for (const [label, origin] of Object.entries(ORIGINS)) {
  test(`the diagram frame's script, one delivery difference at a time (${label})`, async ({ page, browserName }) => {
    test.setTimeout(60_000);
    const reports = new Map<string, number>();
    await serve(page, origin, reports);
    const ran = await ranIn(page, origin);
    for (const [name, value] of Object.entries(ran)) {
      test.info().annotations.push({ type: `${browserName}:${label}:${name}`, description: value ? "ran" : "blocked" });
    }
    console.log(`[${browserName}:${label}] ran ${JSON.stringify(ran)}`);
    console.log(`[${browserName}:${label}] reports ${JSON.stringify(Object.fromEntries(reports))}`);
    // The controls: without the enforced copy, the shipped page runs its shipped script.
    expect(ran["bare-self.minimal-page.marker-script"], "a bare header 'self' runs the marker").toBe(true);
    expect(ran["production-only.shipped-page.shipped-script"], "production's headers run the shipped page").toBe(true);
    const blocked = Object.entries(ran).filter(([, value]) => !value).map(([name]) => name);
    expect(blocked, "frames whose script did not run").toEqual([]);
  });
}

test("the shipped diagram frame from the fixture's own server", async ({ page, browserName, baseURL }) => {
  if (baseURL === undefined) throw new Error("no baseURL");
  const origin = new URL(baseURL).origin;
  const reports = new Map<string, number>();
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (request.method() === "POST" && (url.pathname === REPORT_PATH || url.pathname === ENFORCED_REPORT_PATH)) {
      const key = url.pathname === ENFORCED_REPORT_PATH ? "enforce" : "report";
      reports.set(key, (reports.get(key) ?? 0) + 1);
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.pathname === "/__diagram-host") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>host</title>" });
    return route.fallback();
  });
  await page.goto(`${origin}/__diagram-host`);
  const ran = await page.evaluate(async () => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("src", "/drawing-assets/diagram/index.html");
    let seen = false;
    addEventListener("message", (event) => {
      const data = event.data as { channel?: unknown; type?: unknown } | null;
      if (event.source === frame.contentWindow && data && data.channel === "context-diagram" && data.type === "ready") seen = true;
    });
    document.body.append(frame);
    await new Promise((resolve) => setTimeout(resolve, 6000));
    return seen;
  });
  test.info().annotations.push({ type: `${browserName}:fixture-server:shipped`, description: ran ? "ran" : "blocked" });
  console.log(`[${browserName}:fixture-server] ran ${ran} reports ${JSON.stringify(Object.fromEntries(reports))}`);
  expect(ran, "the shipped diagram page, as the fixture serves it, runs its script").toBe(true);
});
