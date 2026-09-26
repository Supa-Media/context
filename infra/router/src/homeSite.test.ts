/**
 * The homepage carries its site in its HTML: `/` asks Convex's `/site/home`
 * beside the Expo HTML and puts the answer in an inert JSON block, so the
 * app's first paint is the live site. What is checked here: the block cannot
 * break out of its element, only named fields go in, every failure is the
 * untouched HTML, and nothing but `/` on the apex asks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import {
  HOME_SITE_ELEMENT_ID,
  fetchHomeSnapshot,
  injectHomeSnapshot,
  parseHomeSnapshot,
  type HomeSnapshot,
} from "./homeSite";

const ENV = {
  EXPO_ORIGIN: "https://context.expo.app",
  CONVEX_ORIGIN: "https://example-deployment.convex.site",
};
const CTX = {
  waitUntil: (promise: Promise<unknown>) => void promise,
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const BROWSER_UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";
const HTML = "<!DOCTYPE html><html><head><title>Context</title></head><body><div id=root></div></body></html>";

const SITE: HomeSnapshot = {
  siteName: "Context",
  revision: "3:3",
  pages: [
    { path: "index.md", routePath: "/", title: "Welcome", markdown: "# Welcome\n" },
    { path: "Legal/privacy.md", routePath: "/Legal/privacy", title: "Privacy", markdown: "We keep little.\n" },
  ],
};

let convexAnswer: () => Response;
let revisionAnswer: () => Response;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  convexAnswer = () => Response.json(SITE);
  revisionAnswer = () => Response.json({ revision: SITE.revision });
  fetchSpy = vi.fn((input: Request | string) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === `${ENV.CONVEX_ORIGIN}/site/home`) return convexAnswer();
    if (url === `${ENV.CONVEX_ORIGIN}/site/home/revision`) return revisionAnswer();
    return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"abc"' } });
  });
  vi.stubGlobal("fetch", fetchSpy);
});

/** A per-colo cache that keeps what it is given, for the length of one test. */
function stubCache(): Map<string, Response> {
  const stored = new Map<string, Response>();
  vi.stubGlobal("caches", {
    default: {
      match: async (request: Request) => stored.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => void stored.set(request.url, response),
    },
  });
  return stored;
}

const homeCalls = () =>
  fetchSpy.mock.calls.filter(([input]) => input === `${ENV.CONVEX_ORIGIN}/site/home`).length;
afterEach(() => vi.unstubAllGlobals());

function get(path: string, host = "context.lc"): Promise<Response> {
  return worker.fetch(
    new Request(`https://${host}${path}`, { headers: { "User-Agent": BROWSER_UA } }),
    ENV,
    CTX,
  ) as Promise<Response>;
}

function carried(html: string): unknown {
  const match = new RegExp(`<script type="application/json" id="${HOME_SITE_ELEMENT_ID}">(.*?)</script>`).exec(html);
  return match === null ? null : JSON.parse(match[1]!);
}

describe("the homepage's HTML", () => {
  it("carries the site, in its head", async () => {
    const response = await get("/");
    const html = await response.text();
    expect(carried(html)).toEqual(SITE);
    expect(html.indexOf(HOME_SITE_ELEMENT_ID)).toBeLessThan(html.indexOf("</head>"));
    expect(response.headers.get("ETag")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("asks for the homepage's own handle, and nothing else", async () => {
    await get("/?page=pricing");
    const call = fetchSpy.mock.calls.find(([input]) => input === `${ENV.CONVEX_ORIGIN}/site/home`);
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ handle: "context-lc" });
  });

  it.each(["/login", "/@context-lc", "/console"])("%s does not ask", async (path) => {
    await get(path);
    expect(fetchSpy.mock.calls.map(([input]) => String(typeof input === "string" ? input : input.url))).toEqual([
      `https://context.expo.app${path}`,
    ]);
  });

  it.each([
    ["an error", () => new Response("no", { status: 500 })],
    ["a site that is off", () => Response.json({ siteName: null, revision: null, pages: null })],
    ["a body that is not JSON", () => new Response("<html>")],
    ["a page with no file", () => Response.json({ ...SITE, pages: [{ routePath: "/", title: "x", markdown: "" }] })],
    ["a throw", () => {
      throw new Error("down");
    }],
  ])("%s leaves the HTML untouched", async (_name, answer) => {
    convexAnswer = answer;
    revisionAnswer = () => Response.json({ revision: "fresh" });
    const response = await get("/");
    expect(await response.text()).toBe(HTML);
    expect(response.headers.get("ETag")).toBe('"abc"');
  });
});

describe("the copy kept until the next Publish", () => {
  it("is read from the folder once per revision, not once per visit", async () => {
    stubCache();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext;
    for (let visit = 0; visit < 3; visit += 1) {
      expect(await fetchHomeSnapshot(ENV.CONVEX_ORIGIN, "context-lc", ctx)).toEqual(SITE);
    }
    expect(homeCalls()).toBe(1);

    // A Publish is a new revision, so a new copy.
    const PUBLISHED = { ...SITE, revision: "4:4", pages: [SITE.pages[0]!] };
    revisionAnswer = () => Response.json({ revision: "4:4" });
    convexAnswer = () => Response.json(PUBLISHED);
    expect(await fetchHomeSnapshot(ENV.CONVEX_ORIGIN, "context-lc", ctx)).toEqual(PUBLISHED);
    expect(await fetchHomeSnapshot(ENV.CONVEX_ORIGIN, "context-lc", ctx)).toEqual(PUBLISHED);
    expect(homeCalls()).toBe(2);
  });

  it("a site that is off, or a revision nobody can read, is no site", async () => {
    stubCache();
    for (const answer of [() => Response.json({ revision: null }), () => new Response("no", { status: 500 })]) {
      revisionAnswer = answer;
      expect(await fetchHomeSnapshot(ENV.CONVEX_ORIGIN, "context-lc", CTX)).toBeNull();
    }
    expect(homeCalls()).toBe(0);
  });

  it("a late answer is not waited for, and is kept for the next visit when it arrives", async () => {
    vi.useFakeTimers();
    try {
      stubCache();
      let answer!: (response: Response) => void;
      convexAnswer = () => new Promise<Response>((resolve) => (answer = resolve)) as unknown as Response;
      const pending: Promise<unknown>[] = [];
      const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext;

      const first = fetchHomeSnapshot(ENV.CONVEX_ORIGIN, "context-lc", ctx);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await first).toBeNull();

      answer(Response.json(SITE));
      await Promise.all(pending);
      expect(await fetchHomeSnapshot(ENV.CONVEX_ORIGIN, "context-lc", ctx)).toEqual(SITE);
      expect(homeCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the block", () => {
  it("cannot close its own element or open a comment", () => {
    const hostile: HomeSnapshot = {
      ...SITE,
      pages: [{ path: "index.md", routePath: "/", title: "</script><script>alert(1)</script>", markdown: "<!-- x --> & \u2028" }],
    };
    const html = injectHomeSnapshot(HTML, hostile);
    const block = html.slice(html.indexOf(HOME_SITE_ELEMENT_ID));
    expect(block.indexOf("</script>")).toBe(block.lastIndexOf("</script>"));
    expect(block).not.toContain("<!--");
    expect(carried(html)).toEqual(hostile);
  });

  it("names its fields: nothing Convex adds later reaches the page", () => {
    const parsed = parseHomeSnapshot({
      ...SITE,
      workspaceId: "w1",
      pages: [{ ...SITE.pages[0], objectKey: "website/index.md", audience: "public" }],
    });
    expect(parsed).toEqual({ ...SITE, pages: [SITE.pages[0]] });
  });

  it("an HTML document with no head is left as it is", () => {
    expect(injectHomeSnapshot("<p>hi</p>", SITE)).toBe("<p>hi</p>");
  });
});
