/**
 * tex.lc through the whole Worker: the same app, the same auth, Tex's own
 * crawler cards and robots.txt, no context.lc homepage snapshot — and nothing
 * about context.lc changed. route.test.ts holds the decisions; this holds the
 * wiring, with `fetch` stubbed so nothing reaches the network.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";

const ENV = {
  EXPO_ORIGIN: "https://context.expo.app",
  CONVEX_ORIGIN: "https://example-deployment.convex.site",
};
const CTX = {
  waitUntil: (promise: Promise<unknown>) => void promise,
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const BROWSER = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";
const SLACK = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";
const HTML = "<!DOCTYPE html><html><head><title>Context</title></head><body></body></html>";
const TEX_HOSTS = ["tex.lc", "tex-staging.context.lc"];

let fetchSpy: ReturnType<typeof vi.fn>;
let assets: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn((input: Request | string) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(`${ENV.CONVEX_ORIGIN}/site/home`)) return Response.json({ siteName: "Context", revision: "1", pages: [] });
    if (url.startsWith(`${ENV.CONVEX_ORIGIN}/domain/resolve`)) return Response.json({ handle: null, homeSlug: null });
    return new Response(`proxied:${url}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
  assets = vi.fn((request: Request) =>
    new Response(HTML.replace("<title>", `<title>asset:${request.url} `), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function get(url: string, ua: string = BROWSER, withAssets = true): Promise<Response> {
  return worker.fetch(
    new Request(url, { headers: { "User-Agent": ua } }),
    withAssets ? { ...ENV, ASSETS: { fetch: assets } as unknown as Fetcher } : ENV,
    CTX,
  ) as Promise<Response>;
}

const convexCalls = (path: string) =>
  fetchSpy.mock.calls.filter(([input]) => String(typeof input === "string" ? input : input.url).startsWith(`${ENV.CONVEX_ORIGIN}${path}`)).length;

describe("www.tex.lc", () => {
  it("is a cacheable 301 to the apex, path and query kept", async () => {
    const response = await get("https://www.tex.lc/console/@x/a?note=b");
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("https://tex.lc/console/@x/a?note=b");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe.each(TEX_HOSTS)("%s is the same app", (host) => {
  it("a console deep link reaches the assets binding with its URL unchanged", async () => {
    const response = await get(`https://${host}/console/@x/a?note=b`);
    expect(await response.text()).toContain(`asset:https://${host}/console/@x/a?note=b`);
    expect(assets).toHaveBeenCalledTimes(1);
    // Not a customer domain: the control plane was never asked who owns it.
    expect(convexCalls("/domain/resolve")).toBe(0);
  });

  it("auth goes to Convex with the path unchanged", async () => {
    const response = await get(`https://${host}/api/auth/signin/x?code=1`);
    expect(await response.text()).toBe(`proxied:${ENV.CONVEX_ORIGIN}/api/auth/signin/x?code=1`);
    expect(assets).not.toHaveBeenCalled();
  });

  it("`/` is the app's own HTML, without context.lc's homepage website", async () => {
    const response = await get(`https://${host}/`);
    const html = await response.text();
    expect(html).toContain(`asset:https://${host}/`);
    expect(html).not.toContain("context-home-site");
    expect(convexCalls("/site/home")).toBe(0);
  });

  it("a crawler at `/` gets Tex's card, canonical on tex.lc", async () => {
    const response = await get(`https://${host}/`, SLACK);
    const html = await response.text();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toBe("User-Agent");
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
    expect(html).toContain("<title>Tex: a personal assistant you just text</title>");
    expect(html).toContain(
      '<meta name="description" content="Tex keeps track of what you tell it, looks things up, puts plans on your calendar and reminds you. It asks before it sends anything. iMessage only, invite only for now.">',
    );
    expect(html).toContain('<link rel="canonical" href="https://tex.lc/">');
    expect(html).toContain('<meta property="og:url" content="https://tex.lc/">');
    expect(html).toContain('<meta property="og:image" content="https://tex.lc/og/tex-card.png">');
    expect(html).toContain('<meta property="og:site_name" content="Tex">');
    expect(html).not.toContain("context.lc");
    expect(html).not.toContain(host === "tex.lc" ? "tex-staging" : "tex-staging.context.lc");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a crawler at `/waitlist` is told noindex, in the tags and the header", async () => {
    const response = await get(`https://${host}/waitlist?ref=abc`, SLACK);
    const html = await response.text();
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain("<title>Tex: a personal assistant you just text</title>");
    expect(html).not.toContain("abc");
    expect(html).not.toContain("context.lc");
  });

  it("any other path is one frozen Tex card, byte for byte", async () => {
    const bodies = new Set<string>();
    for (const path of ["/login", "/@alice", "/@nobody", "/console/@x/a?note=b", "/whatever"]) {
      const response = await get(`https://${host}${path}`, SLACK);
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      bodies.add(await response.text());
    }
    expect(bodies.size).toBe(1);
    const [html] = [...bodies];
    expect(html).toContain('<link rel="canonical" href="https://tex.lc/">');
    expect(html).not.toContain("context.lc");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("robots.txt keeps the waitlist and the console out of search", async () => {
    const response = await get(`https://${host}/robots.txt`, SLACK);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const body = await response.text();
    expect(body).toMatch(/^User-agent: \*$/m);
    expect(body).toMatch(/^Disallow: \/waitlist$/m);
    expect(body).toMatch(/^Disallow: \/console$/m);
    expect(body).toMatch(/^Allow: \/$/m);
  });
});

describe("context.lc is unchanged", () => {
  it("a crawler at `/` gets Context's card", async () => {
    const response = await get("https://context.lc/", SLACK);
    const html = await response.text();
    expect(html).toContain('<link rel="canonical" href="https://context.lc/">');
    expect(html).toContain('<meta property="og:image" content="https://context.lc/og/card.png">');
    expect(html).not.toContain("tex.lc");
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
  });

  it("`/` still carries the homepage website", async () => {
    const html = await (await get("https://context.lc/")).text();
    expect(html).toContain("context-home-site");
    expect(convexCalls("/site/home")).toBeGreaterThan(0);
  });

  it("robots.txt still allows everything", async () => {
    expect(await (await get("https://context.lc/robots.txt")).text()).toBe("User-agent: *\nAllow: /\n");
  });
});

describe("/og/tex-card.png", () => {
  const png = readFileSync(fileURLToPath(new URL("./og-tex-card.png", import.meta.url)));

  it.each(["tex.lc", "context.lc", "tex-staging.context.lc"])("is the bundled 1200x630 PNG on %s", async (host) => {
    const response = await get(`https://${host}/og/tex-card.png`, SLACK);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(png));
    const view = new DataView(bytes.buffer);
    // IHDR: width at byte 16, height at byte 20 — what og:image:width/height promise.
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a host that is not ours is still a customer's", () => {
  it.each(["unknown-test.com", "app.tex.lc"])("%s asks the control plane, and 404s when nobody owns it", async (host) => {
    const response = await get(`https://${host}/`, BROWSER, false);
    expect(response.status).toBe(404);
    expect(convexCalls("/domain/resolve")).toBe(1);
    expect(assets).not.toHaveBeenCalled();
  });
});

describe("the Google connect guide Tex texts", () => {
  it("is served as the bundled 1080x1350 PNG", async () => {
    const png = readFileSync(fileURLToPath(new URL("./og-google-connect.png", import.meta.url)));
    const response = await get("https://context.lc/og/google-connect.png", BROWSER);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(png));
    const view = new DataView(bytes.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1080, 1350]);
  });
});

describe("a Slack connect link", () => {
  const png = readFileSync(fileURLToPath(new URL("./og-connect-slack.png", import.meta.url)));
  const IMESSAGE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0";

  it("unfurls as one frozen card, whatever the token", async () => {
    const live = await (await get("https://context.lc/connect/slack/abcdefghijklmnopqrstuvwx", IMESSAGE)).text();
    const guessed = await (await get("https://context.lc/connect/slack/zzzzzzzzzzzzzzzzzzzzzzzz", IMESSAGE)).text();
    expect(live).toContain('<meta property="og:title" content="Connect Slack to Tex">');
    expect(live).toContain('<meta property="og:image" content="https://context.lc/og/connect-slack.png">');
    expect(live).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(guessed).toBe(live);
  });

  it("serves its card as the bundled 1200x630 PNG", async () => {
    const response = await get("https://context.lc/og/connect-slack.png", IMESSAGE);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(png));
    const view = new DataView(bytes.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630]);
  });
});
