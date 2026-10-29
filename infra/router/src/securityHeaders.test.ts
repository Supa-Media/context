/**
 * Every platform response carries the browser hardening in securityHeaders.ts,
 * a branch's own stricter header still wins, and a customer's domain is left
 * to its own routing table.
 *
 * `fetch` is stubbed, so nothing here reaches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENFORCED_POLICY, SECURITY_HEADERS, withSecurityHeaders } from "./securityHeaders";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const CTX = {
  waitUntil: (promise: Promise<unknown>) => void promise,
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const assets = vi.fn(() => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }));
const ENV = {
  CONVEX_ORIGIN: "https://example-deployment.convex.site",
  ASSETS: { fetch: assets } as unknown as Fetcher,
};

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn((request: Request) => new Response(`proxied:${request.url}`));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

function get(url: string, userAgent = BROWSER_UA): Promise<Response> {
  return worker.fetch(new Request(url, { headers: { "User-Agent": userAgent } }), ENV, CTX) as Promise<Response>;
}

function expectHardened(response: Response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (name === "Referrer-Policy") continue;
    expect(response.headers.get(name), name).toBe(value);
  }
  expect(response.headers.get("Referrer-Policy")).not.toBeNull();
}

describe("platform responses are hardened", () => {
  it.each([
    ["the app on context.lc", "https://context.lc/console"],
    ["the app on tex.lc", "https://tex.lc/settings"],
    ["the app on staging", "https://staging.context.lc/console"],
    ["the auth routes proxied to Convex", "https://context.lc/api/auth/callback/github?code=abc"],
    ["robots.txt", "https://context.lc/robots.txt"],
  ])("%s", async (_name, url) => {
    expectHardened(await get(url));
  });

  it("the app document keeps its body", async () => {
    const response = await get("https://context.lc/console");
    await expect(response.text()).resolves.toBe("<!doctype html>");
  });

  it("a crawler's preview card keeps its own no-referrer", async () => {
    const response = await get("https://context.lc/", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });
});

describe("withSecurityHeaders", () => {
  it("leaves a header a branch set", () => {
    const response = withSecurityHeaders(new Response("x", { headers: { "Content-Security-Policy": "default-src 'none'" } }));
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
  });

  it("works on a response whose headers are immutable", () => {
    const response = withSecurityHeaders(Response.redirect("https://context.lc/", 302));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://context.lc/");
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });
});

/** Every handwritten web source of the app and the router, skipping built bundles and dependencies. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "drawing-assets" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(?:tsx?|html)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("the enforced policy", () => {
  const repo = join(__dirname, "..", "..", "..");
  const app = [join(repo, "apps", "mobile", "app"), join(repo, "apps", "mobile", "features"), join(repo, "apps", "mobile", "components"), join(repo, "apps", "mobile", "public")]
    .flatMap((dir) => {
      try {
        return sources(dir);
      } catch {
        return [];
      }
    })
    .map((path) => [path, readFileSync(path, "utf8")] as const);

  it("defines every directive with no default-src fallback, and nothing that blocks script or style", () => {
    const directives = ENFORCED_POLICY.split(";").map((part) => part.trim().split(/\s+/)[0]);
    expect(directives).toEqual(["frame-ancestors", "form-action", "object-src", "base-uri"]);
    expect(ENFORCED_POLICY).not.toMatch(/default-src|script-src|style-src|connect-src|img-src|font-src/);
  });

  it("form-action 'self' holds because every form in the app submits by script, never by navigation", () => {
    const forms = app.filter(([, text]) => /<form\b/.test(text));
    expect(forms.length).toBeGreaterThan(0);
    for (const [path, text] of forms) {
      const opened = (text.match(/<form\b/g) ?? []).length;
      const prevented = (text.match(/event\.preventDefault\(\)/g) ?? []).length;
      expect(prevented, path).toBeGreaterThanOrEqual(opened);
      expect(text, path).not.toMatch(/<form\b[^>]*\baction=/);
    }
  });

  it("object-src 'none' and base-uri 'self' hold because nothing in the app makes an object, an embed or a base", () => {
    for (const [path, text] of app) {
      // A tag that does anything has an attribute (`href`, `data`, `src`), which keeps out `<base>` in prose.
      expect(text, path).not.toMatch(/<(?:object|embed|base)\s+[a-zA-Z-]+=|createElement\(["'](?:object|embed|base)["']\)/);
    }
  });
});
