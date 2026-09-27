/**
 * `/_site/page` keeps a site's page at the edge per revision, so the bucket is
 * read once per Publish rather than on every visit. What is checked here: a
 * second visit under the same revision reads nothing but the revision; a new
 * revision asks again; an answer Convex says not to keep is not kept; a
 * customer's domain can only ever ask for its own handle; every failure is a
 * 503 the app answers by asking Convex itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { pageKey, parseSitePage, sitePageAsk } from "./sitePages";

const ENV = {
  EXPO_ORIGIN: "https://context.expo.app",
  CONVEX_ORIGIN: "https://example-deployment.convex.site",
};
const CTX = {
  waitUntil: (promise: Promise<unknown>) => void promise,
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const PAGE = {
  kind: "page",
  siteName: "Acme",
  routePath: "/about",
  audience: "public",
  title: "About",
  description: null,
  markdown: "We make things.\n",
  navigation: [{ title: "About", routePath: "/about" }],
};

let revision: string | null;
let pageAnswer: () => Response;
let asked: Array<{ path: string; body: unknown }>;

beforeEach(() => {
  revision = "4:rel_1:scanned";
  pageAnswer = () => Response.json({ revision, cacheable: true, address: PAGE });
  asked = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      const body = init?.body === undefined ? null : JSON.parse(String(init.body));
      asked.push({ path: url.pathname, body });
      if (url.pathname === "/site/revision") return Response.json({ revision });
      if (url.pathname === "/site/page") return pageAnswer();
      if (url.pathname === "/domain/resolve") return Response.json({ handle: "acme", homeSlug: "welcome" });
      return new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
    }),
  );
  const stored = new Map<string, Response>();
  vi.stubGlobal("caches", {
    default: {
      match: async (request: Request) => stored.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => void stored.set(request.url, response),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const visit = (url: string, method = "GET") =>
  worker.fetch(new Request(url, { method }), ENV as never, CTX);
const pagesAsked = () => asked.filter((call) => call.path === "/site/page");

describe("a page is read once per revision", () => {
  it("serves the second visit from the copy, asking only the revision", async () => {
    const first = await visit("https://context.lc/_site/page?handle=acme&path=%2Fabout");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(PAGE);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(first.headers.get("X-Robots-Tag")).toContain("noindex");

    const second = await visit("https://context.lc/_site/page?handle=acme&path=%2Fabout");
    expect(await second.json()).toEqual(PAGE);
    expect(pagesAsked()).toHaveLength(1);
    expect(asked.filter((call) => call.path === "/site/revision")).toHaveLength(2);
    expect(pagesAsked()[0]!.body).toEqual({ handle: "acme", routePath: "/about" });
  });

  it("asks again when the revision moves", async () => {
    await visit("https://context.lc/_site/page?handle=acme&path=%2Fabout");
    revision = "5:rel_2:scanned";
    await visit("https://context.lc/_site/page?handle=acme&path=%2Fabout");
    expect(pagesAsked()).toHaveLength(2);
  });

  it("does not keep what Convex says not to", async () => {
    pageAnswer = () =>
      Response.json({ revision, cacheable: false, address: { kind: "unavailable", siteName: "Acme", navigation: [] } });
    await visit("https://context.lc/_site/page?handle=acme&path=%2Fabout");
    const again = await visit("https://context.lc/_site/page?handle=acme&path=%2Fabout");
    expect(await again.json()).toMatchObject({ kind: "unavailable" });
    expect(pagesAsked()).toHaveLength(2);
  });

  it("keeps each address, and each legacy slug, apart", async () => {
    await visit("https://context.lc/_site/page?handle=acme&path=%2Fabout");
    await visit("https://context.lc/_site/page?handle=acme&path=%2Fteam");
    await visit("https://context.lc/_site/page?handle=acme&path=%2F&legacy=hello");
    await visit("https://context.lc/_site/page?handle=other&path=%2Fabout");
    expect(pagesAsked().map((call) => call.body)).toEqual([
      { handle: "acme", routePath: "/about" },
      { handle: "acme", routePath: "/team" },
      { handle: "acme", routePath: "/", legacySlug: "hello" },
      { handle: "other", routePath: "/about" },
    ]);
  });
});

describe("a customer's domain", () => {
  it("asks for its own handle, whatever the query says", async () => {
    const response = await visit("https://docs.acme.com/_site/page?handle=victim&path=%2F&legacy=theirs");
    expect(response.status).toBe(200);
    expect(pagesAsked()[0]!.body).toEqual({ handle: "acme", routePath: "/", legacySlug: "welcome" });
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("only offers its home slug on /", async () => {
    await visit("https://docs.acme.com/_site/page?path=%2Fabout&legacy=theirs");
    expect(pagesAsked()[0]!.body).toEqual({ handle: "acme", routePath: "/about" });
  });
});

describe("failures", () => {
  it("is a 503 when Convex does not answer, and nothing is kept", async () => {
    pageAnswer = () => new Response("down", { status: 500 });
    expect((await visit("https://context.lc/_site/page?handle=acme&path=%2Fabout")).status).toBe(503);
    pageAnswer = () => Response.json({ revision, cacheable: true, address: { kind: "surprise" } });
    expect((await visit("https://context.lc/_site/page?handle=acme&path=%2Fabout")).status).toBe(503);
  });

  it("refuses a malformed ask without asking anybody", async () => {
    for (const url of [
      "https://context.lc/_site/page?handle=acme",
      "https://context.lc/_site/page?handle=ACME!&path=%2F",
      "https://context.lc/_site/page?handle=acme&path=about",
      "https://context.lc/_site/page?handle=acme&path=%2F%0Aevil",
      "https://context.lc/_site/page?handle=acme&path=%2F&legacy=..%2Fx",
    ]) {
      expect((await visit(url)).status).toBe(400);
    }
    expect((await visit("https://context.lc/_site/page?handle=acme&path=%2F", "POST")).status).toBe(405);
    expect(asked.filter((call) => call.path.startsWith("/site/"))).toEqual([]);
  });
});

describe("pieces", () => {
  it("builds its key from checked parts only", () => {
    const ask = sitePageAsk(new URL("https://context.lc/_site/page?handle=acme&path=%2Fa%2Fb"), null)!;
    expect(pageKey(ask, "4:rel_1:scanned").url).toBe(
      "https://site-page.invalid/acme/4%3Arel_1%3Ascanned/%2Fa%2Fb",
    );
  });

  it("never keeps an answer with no revision", () => {
    expect(parseSitePage({ revision: null, cacheable: true, address: PAGE })?.cacheable).toBe(false);
    expect(parseSitePage({ revision: 4, cacheable: true, address: PAGE })).toBeNull();
    expect(parseSitePage(null)).toBeNull();
  });
});
