/**
 * Hashed `/_expo/` files are cacheable for a year. The shell Static Assets
 * serves in their place is not, and a page stays `no-cache`.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `withExpoAssetCache` returning the binding response unchanged →
 *     "a hashed /_expo/ asset is immutable" (header stays `max-age=0`).
 *  2. The HTML check removed → "a missing /_expo/ asset is a 404, not the shell"
 *     (status 200, body is the shell).
 *  3. The `/_expo/` guard removed, so every assets response is cached as a bundle →
 *     "a page stays no-cache" (the console is a 404).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";

const SHELL = readFileSync(join(__dirname, "..", "..", "..", "apps", "mobile", "public", "index.html"), "utf8");
const BUNDLE = "/* hashed bundle */";
const REVALIDATE = "public, max-age=0, must-revalidate";
const IMMUTABLE = "public, max-age=31536000, immutable";

const CTX = {
  waitUntil: (promise: Promise<unknown>) => {
    void promise;
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const ENV = {
  CONVEX_ORIGIN: "https://example-deployment.convex.site",
  ASSETS: {
    fetch: (request: Request) => {
      const path = new URL(request.url).pathname;
      const headers = { "Cache-Control": REVALIDATE, ETag: '"asset"' };
      if (path.includes("nonexistent")) {
        return new Response(SHELL, { status: 200, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
      }
      if (request.headers.get("If-None-Match") === '"js"') {
        return new Response(null, { status: 304, headers: { ...headers, "Content-Type": "text/javascript", ETag: '"js"' } });
      }
      if (path.startsWith("/_expo/") && path.endsWith(".js")) {
        return new Response(BUNDLE, { status: 200, headers: { ...headers, "Content-Type": "text/javascript", ETag: '"js"' } });
      }
      return new Response(SHELL, { status: 200, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
    },
  } as unknown as Fetcher,
};

function ask(host: string, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(new Request(`https://${host}${path}`, { headers }), ENV, CTX) as Promise<Response>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hashed /_expo/ assets from Static Assets", () => {
  it.each(["context.lc", "tex.lc"])("a hashed /_expo/ asset is immutable on %s", async (host) => {
    const response = await ask(host, "/_expo/static/js/web/entry-abc123.js", {
      Accept: "*/*",
      "Sec-Fetch-Dest": "script",
      "Sec-Fetch-Mode": "no-cors",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript");
    expect(response.headers.get("Cache-Control")).toBe(IMMUTABLE);
    expect(response.headers.get("ETag")).toBe('"js"');
    expect(await response.text()).toBe(BUNDLE);
  });

  it("a revalidated hashed asset stays immutable", async () => {
    const response = await ask("context.lc", "/_expo/static/js/web/entry-abc123.js", {
      Accept: "*/*",
      "Sec-Fetch-Dest": "script",
      "If-None-Match": '"js"',
    });
    expect(response.status).toBe(304);
    expect(response.headers.get("Content-Type")).toBe("text/javascript");
    expect(response.headers.get("Cache-Control")).toBe(IMMUTABLE);
    expect(await response.text()).toBe("");
  });

  it.each([
    ["a script fetch", { Accept: "*/*", "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "no-cors" }],
    ["a navigation", { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" }],
  ])("a missing /_expo/ asset is a 404, not the shell, for %s", async (_label, headers) => {
    const response = await ask("context.lc", "/_expo/static/js/web/nonexistent-abc.js", headers);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBeNull();
    const body = await response.text();
    expect(body).toBe("");
    expect(body).not.toContain("<html");
    expect(body).not.toContain("expo-reset");
  });

  it.each(["context.lc", "tex.lc"])("a page stays no-cache on %s", async (host) => {
    const response = await ask(host, "/console", {
      Accept: "text/html",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    const body = await response.text();
    expect(body).toContain('id="expo-reset"');
    expect(body).not.toContain(IMMUTABLE);
  });
});
