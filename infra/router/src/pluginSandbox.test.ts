/**
 * The plugin sandbox is a page of its own (`pluginSandbox.ts`): the router
 * hands that path only the sandbox page, under the sandbox's own policy, and
 * never the console's fallback document.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import worker from "./index";
import { PLUGIN_SANDBOX_PREFIX, SANDBOX_POLICY } from "./pluginSandbox";
import { reportOnlyPolicyFor } from "./cspReport";

// The runtime is untyped JavaScript, so it is loaded by a path the compiler
// does not resolve and its one export is checked before use.
const SANDBOX_MODULE = pathToFileURL(join(__dirname, "..", "..", "..", "packages", "obsidian-runtime", "src", "sandbox.js")).href;
const runtime: unknown = await import(/* @vite-ignore */ SANDBOX_MODULE);
function pluginSandboxDocument(): string {
  if (typeof runtime !== "object" || runtime === null || !("pluginSandboxDocument" in runtime)) throw new Error("no pluginSandboxDocument");
  const build = runtime.pluginSandboxDocument;
  if (typeof build !== "function") throw new Error("pluginSandboxDocument is not a function");
  const page: unknown = build();
  if (typeof page !== "string") throw new Error("pluginSandboxDocument returned no page");
  return page;
}

const CTX = { waitUntil: (promise: Promise<unknown>) => void promise, passThroughOnException: () => {} } as unknown as ExecutionContext;

function envServing(body: string, status = 200) {
  const fetch = vi.fn((_request: Request) => new Response(body, { status, headers: { "Content-Type": "text/html" } }));
  return { fetch, env: { CONVEX_ORIGIN: "https://example-deployment.convex.site", ASSETS: { fetch } as unknown as Fetcher } };
}

function get(path: string, env: unknown, method = "GET"): Promise<Response> {
  return worker.fetch(new Request(`https://context.lc${path}`, { method }), env as never, CTX) as Promise<Response>;
}

describe("the plugin sandbox page", () => {
  it("is served with the policy its own meta tag enforces", async () => {
    const page = pluginSandboxDocument();
    expect(page).toContain(`<meta http-equiv="Content-Security-Policy" content="${SANDBOX_POLICY}">`);
    const { env, fetch } = envServing(page);
    for (const path of [`${PLUGIN_SANDBOX_PREFIX}index.html`, PLUGIN_SANDBOX_PREFIX]) {
      const response = await get(path, env);
      expect(response.status, path).toBe(200);
      await expect(response.text()).resolves.toBe(page);
      expect(response.headers.get("Content-Security-Policy")).toBe(`${SANDBOX_POLICY}; frame-ancestors 'self'`);
      expect(response.headers.get("Content-Security-Policy-Report-Only")).toBe(`${SANDBOX_POLICY}; report-uri /_csp-report`);
      expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    }
    expect(fetch.mock.calls.every(([request]) => new URL(request.url).pathname === PLUGIN_SANDBOX_PREFIX)).toBe(true);
  });

  it("is never the console's fallback document", async () => {
    const { env } = envServing('<!doctype html><div id="root"></div>');
    const response = await get(`${PLUGIN_SANDBOX_PREFIX}index.html`, env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("root");
  });

  it("answers nothing else under its path, and only reads", async () => {
    const { env, fetch } = envServing(pluginSandboxDocument());
    expect((await get(`${PLUGIN_SANDBOX_PREFIX}other.html`, env)).status).toBe(404);
    expect((await get(`${PLUGIN_SANDBOX_PREFIX}index.html`, env, "POST")).status).toBe(405);
    expect(fetch).not.toHaveBeenCalled();
    const head = await get(`${PLUGIN_SANDBOX_PREFIX}index.html`, env, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("allows inline script only on its own path", () => {
    expect(SANDBOX_POLICY).toContain("script-src 'unsafe-inline'");
    expect(SANDBOX_POLICY).toContain("connect-src 'none'");
    for (const path of ["/console", "/", "/drawing-assets/editor/index.html", "/drawing-assets/plugin-sandboxed"]) {
      expect(reportOnlyPolicyFor(path, undefined), path).not.toContain("'unsafe-inline'");
    }
  });
});
