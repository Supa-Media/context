/**
 * Every app shell response carries a style nonce of its own, in its two
 * inline styles and its report-only `style-src` and nowhere else, and cannot
 * be revalidated into another response's. The enforced policy is unchanged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { reportOnlyPolicyFor, SCRIPT_POLICY } from "./cspReport";
import { ENFORCED_POLICY } from "./securityHeaders";
import { NONCED_STYLE_IDS, freshNonce, policyWithNonce, withStyleNonce } from "./styleNonce";

const SHELL = readFileSync(join(__dirname, "..", "..", "..", "apps", "mobile", "public", "index.html"), "utf8");
const CTX = { waitUntil: (promise: Promise<unknown>) => void promise, passThroughOnException: () => {} } as unknown as ExecutionContext;
const CONVEX = "https://example-deployment.convex.site";

let seen: Request[];
let answer: (request: Request) => Response;
const assets = vi.fn((request: Request) => {
  seen.push(request);
  return answer(request);
});
const ENV = { CONVEX_ORIGIN: CONVEX, ASSETS: { fetch: assets } as unknown as Fetcher };

const html = (body = SHELL) =>
  new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"abc"', "Last-Modified": "Wed, 28 Oct 2026 10:00:00 GMT" } });

beforeEach(() => {
  seen = [];
  answer = () => html();
  // The home site's snapshot is asked of the control plane; with none, the document is the shell as served.
  vi.stubGlobal("fetch", vi.fn(() => new Response("not found", { status: 404 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function navigate(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request(`https://context.lc${path}`, {
    headers: { "Sec-Fetch-Dest": "document", Accept: "text/html,application/xhtml+xml", ...headers },
  });
  return worker.fetch(request, ENV, CTX) as Promise<Response>;
}

/** The `'nonce-…'` values in a policy's `style-src`. */
function styleNonces(policy: string | null): string[] {
  return (policy ?? "")
    .split(";")
    .map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name === "style-src")
    .flatMap((sources) => sources.filter((source) => source.startsWith("'nonce-")).map((source) => source.slice(7, -1)));
}

describe("the nonce", () => {
  it("is 128 random bits, new every time", () => {
    const nonces = new Set(Array.from({ length: 50 }, freshNonce));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(atob(nonce)).toHaveLength(16);
  });

  it("goes on the real shell's two inline styles, and on nothing else", () => {
    const out = withStyleNonce(SHELL, "TESTNONCE");
    expect(out).not.toBeNull();
    for (const id of NONCED_STYLE_IDS) expect(out).toContain(`<style id="${id}" nonce="TESTNONCE">`);
    expect(out!.split('nonce="TESTNONCE"').length - 1).toBe(NONCED_STYLE_IDS.length);
  });

  it("leaves a document without the shell's styles alone", () => {
    expect(withStyleNonce("<!doctype html><style>p{}</style>", "N")).toBeNull();
    expect(withStyleNonce(SHELL.replace('<style id="context-ground">', "<style>"), "N")).toBeNull();
  });

  it("is added to style-src only, and never beside 'unsafe-inline'", () => {
    const policy = policyWithNonce(SCRIPT_POLICY, "N");
    expect(styleNonces(policy)).toEqual(["N"]);
    expect(policy).not.toContain("script-src 'self' 'nonce-");
    expect(policy!.replace(" 'nonce-N'", "")).toBe(SCRIPT_POLICY);
    expect(policyWithNonce("script-src 'self'; style-src 'self' 'unsafe-inline'", "N")).toBeNull();
    expect(policyWithNonce("script-src 'self'", "N")).toBeNull();
  });

  it("is placed exactly as the browser suite's fixture places it", async () => {
    const fixture = (await import(pathToFileURL(join(__dirname, "..", "..", "..", "apps", "mobile", "e2e", "webkit", "csp-style-nonce.mjs")).href)) as {
      NONCED_STYLE_IDS: string[];
      withStyleNonce: (html: string, nonce: string) => string;
      policyWithNonce: (policy: string, nonce: string) => string;
    };
    expect(fixture.NONCED_STYLE_IDS).toEqual([...NONCED_STYLE_IDS]);
    expect(withStyleNonce(SHELL, "N")).toBe(fixture.withStyleNonce(SHELL, "N"));
    const policy = reportOnlyPolicyFor("/console", CONVEX);
    expect(policyWithNonce(policy, "N")).toBe(fixture.policyWithNonce(policy, "N"));
  });
});

describe("a shell response", () => {
  it("carries one fresh nonce in its styles and its report-only style-src, and the enforced policy is unchanged", async () => {
    const nonces: string[] = [];
    for (const path of ["/console", "/console", "/note/@someone/a.md", "/"]) {
      const response = await navigate(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Security-Policy")).toBe(ENFORCED_POLICY);
      const [nonce, ...more] = styleNonces(response.headers.get("Content-Security-Policy-Report-Only"));
      expect(more).toEqual([]);
      expect(nonce).toBeTruthy();
      const body = await response.text();
      for (const id of NONCED_STYLE_IDS) expect(body).toContain(`<style id="${id}" nonce="${nonce}">`);
      expect(body.split(`nonce="${nonce}"`).length - 1).toBe(NONCED_STYLE_IDS.length);
      expect(response.headers.get("Content-Security-Policy-Report-Only")!.replace(` 'nonce-${nonce}'`, "")).toBe(
        reportOnlyPolicyFor(path, CONVEX),
      );
      nonces.push(nonce!);
    }
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it("has nothing to revalidate, and is never asked for conditionally", async () => {
    const response = await navigate("/console", { "If-None-Match": '"abc"', "If-Modified-Since": "Wed, 28 Oct 2026 10:00:00 GMT" });
    expect(response.headers.get("ETag")).toBeNull();
    expect(response.headers.get("Last-Modified")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("If-None-Match")).toBeNull();
    expect(seen[0]!.headers.get("If-Modified-Since")).toBeNull();
  });

  it("is recognised by Accept alone, as a navigation without fetch metadata is", async () => {
    const request = new Request("https://context.lc/console", { headers: { Accept: "text/html" } });
    const response = (await worker.fetch(request, ENV, CTX)) as Response;
    expect(styleNonces(response.headers.get("Content-Security-Policy-Report-Only"))).toHaveLength(1);
  });
});

describe("what is left as it was", () => {
  it("the app's files: no nonce, and a conditional request still gets its 304", async () => {
    answer = () => new Response(null, { status: 304, headers: { ETag: '"js"' } });
    const request = new Request("https://context.lc/_expo/static/js/web/entry-abc.js", {
      headers: { Accept: "*/*", "Sec-Fetch-Dest": "script", "If-None-Match": '"js"' },
    });
    const response = (await worker.fetch(request, ENV, CTX)) as Response;
    expect(response.status).toBe(304);
    expect(seen[0]!.headers.get("If-None-Match")).toBe('"js"');
    expect(styleNonces(response.headers.get("Content-Security-Policy-Report-Only"))).toEqual([]);
  });

  it("the drawing editor, which has a policy of its own", async () => {
    const response = await navigate("/drawing-assets/editor/index.html");
    expect(styleNonces(response.headers.get("Content-Security-Policy-Report-Only"))).toEqual([]);
    expect(await response.text()).toBe(SHELL);
  });

  it("an HTML document without the shell's styles", async () => {
    answer = () => html("<!doctype html><p>other</p>");
    const response = await navigate("/console");
    expect(styleNonces(response.headers.get("Content-Security-Policy-Report-Only"))).toEqual([]);
    expect(response.headers.get("Content-Security-Policy-Report-Only")).toBe(reportOnlyPolicyFor("/console", CONVEX));
    expect(await response.text()).toBe("<!doctype html><p>other</p>");
  });

  it("a response that is not a 200", async () => {
    answer = () => new Response("missing", { status: 404, headers: { "Content-Type": "text/html" } });
    const response = await navigate("/console");
    expect(response.status).toBe(404);
    expect(styleNonces(response.headers.get("Content-Security-Policy-Report-Only"))).toEqual([]);
  });
});
