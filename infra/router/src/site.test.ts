/**
 * Customer domains, at the router: the closed routing table in `site.ts`, and
 * the wiring in `siteWorker.ts` that decides which workspace a host serves.
 *
 * The properties that matter are negative ones — a host we do not serve gets
 * nothing, a path outside the table gets nothing, and nothing in the request
 * except the hostname it arrived at can choose the workspace — so most of
 * these assert what was NOT fetched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { isPlatformHost, siteRoute } from "./site";

const ENV = {
  EXPO_ORIGIN: "https://context.expo.app",
  CONVEX_ORIGIN: "https://example-deployment.convex.site",
};
const CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const SLACK = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";
const BROWSER =
  "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";

/** The control plane: which hosts are live sites, and for whom. */
const SITES: Record<string, { handle: string; homeSlug: string | null }> = {
  "docs.acme-test.com": { handle: "acme", homeSlug: "welcome" },
  "globex-test.com": { handle: "globex", homeSlug: null },
};

/** The control plane's answer for a website page, by `handle:routePath`. */
const PAGES: Record<string, { title: string; description: string | null; siteName: string; cardVersion: string | null }> = {
  "globex:/": { title: "Globex", description: "We make things.", siteName: "Globex", cardVersion: "0123abcd" },
  "globex:/writing/hello": {
    title: "Hello, world",
    description: "The first post.",
    siteName: "Globex",
    cardVersion: "89abcdef",
  },
  "globex:/hostile": {
    title: '"><script>x()</script>',
    description: null,
    siteName: "Globex",
    cardVersion: null,
  },
};
const NO_PAGE = { title: null, description: null, siteName: null, cardVersion: null };

let calls: { url: string; body: string | null }[];
let controlPlaneDown: boolean;

beforeEach(() => {
  calls = [];
  controlPlaneDown = false;
  vi.stubGlobal(
    "fetch",
    async (input: Request | string, init?: RequestInit) => {
      const request =
        typeof input === "string" ? new Request(input, init) : input;
      const body =
        request.method === "POST" ? await request.clone().text() : null;
      calls.push({ url: request.url, body });
      if (request.url === `${ENV.CONVEX_ORIGIN}/domain/resolve`) {
        if (controlPlaneDown) throw new Error("down");
        const { hostname } = JSON.parse(body ?? "{}") as { hostname: string };
        return Response.json(
          SITES[hostname] ?? { handle: null, homeSlug: null },
        );
      }
      if (request.url === `${ENV.CONVEX_ORIGIN}/share/short`) {
        const { handle, slug } = JSON.parse(body ?? "{}") as {
          handle: string;
          slug: string;
        };
        return Response.json({ title: `${handle}:${slug}`, cardVersion: null });
      }
      if (request.url === `${ENV.CONVEX_ORIGIN}/site/preview`) {
        const { handle, routePath } = JSON.parse(body ?? "{}") as { handle: string; routePath: string };
        return Response.json(PAGES[`${handle}:${routePath}`] ?? NO_PAGE);
      }
      if (request.url === `${ENV.CONVEX_ORIGIN}/site/card`) {
        const { handle, routePath, version } = JSON.parse(body ?? "{}") as {
          handle: string;
          routePath: string;
          version: string;
        };
        const current = PAGES[`${handle}:${routePath}`]?.cardVersion;
        return current && current === version
          ? new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "Content-Type": "image/png" } })
          : new Response(null, { status: 404 });
      }
      if (request.url.startsWith(ENV.EXPO_ORIGIN))
        return new Response(`spa:${new URL(request.url).pathname}`);
      throw new Error(`unexpected fetch ${request.url}`);
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function get(
  url: string,
  init: { ua?: string; headers?: Record<string, string>; method?: string } = {},
) {
  return worker.fetch(
    new Request(url, {
      method: init.method ?? "GET",
      headers: { "User-Agent": init.ua ?? BROWSER, ...init.headers },
    }),
    ENV,
    CTX,
  ) as Promise<Response>;
}

const upstreamPaths = () =>
  calls
    .filter((c) => c.url.startsWith(ENV.EXPO_ORIGIN))
    .map((c) => new URL(c.url).pathname);

describe("which hosts are ours", () => {
  it.each([
    "context.lc",
    "www.context.lc",
    "staging.context.lc",
    "context-router.example.workers.dev",
    "localhost",
  ])("%s is the platform", (host) => expect(isPlatformHost(host)).toBe(true));
  it.each(["docs.acme-test.com", "context.lc.acme-test.com", "evilcontext.lc"])(
    "%s is a customer's",
    (host) => expect(isPlatformHost(host)).toBe(false),
  );
});

describe("a live customer domain", () => {
  it("serves the SPA at the root, a legacy short link, and website routes, marked noindex", async () => {
    for (const path of [
      "/",
      "/intake",
      "/writing/hello",
      "/About",
      "/caf%C3%A9?from=nav",
    ]) {
      const response = await get(`https://docs.acme-test.com${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    }
    expect(upstreamPaths()).toEqual([
      "/",
      "/intake",
      "/writing/hello",
      "/About",
      "/caf%C3%A9",
    ]);
  });

  it("serves the bundle and the page's own static files", async () => {
    await get("https://docs.acme-test.com/_expo/static/js/web/entry-abc.js");
    await get("https://docs.acme-test.com/manifest.webmanifest");
    expect(upstreamPaths()).toEqual([
      "/_expo/static/js/web/entry-abc.js",
      "/manifest.webmanifest",
    ]);
  });

  it.each([
    "/api/auth/signin/resend",
    "/@globex/intake",
    "/console/@acme",
    "/s/0000000000000000000000000000000000000000000000000000000000000000",
    "/intake%2Fextra",
    "/a%70i/private",
    "/.hidden/page",
    "/writing//hello",
    "/writing/%252e%252e/console",
  ])("refuses %s without reaching the app or the auth routes", async (path) => {
    const response = await get(`https://docs.acme-test.com${path}`);
    expect(response.status).toBe(404);
    expect(upstreamPaths()).toEqual([]);
    expect(calls.some((c) => c.url.includes("/api/auth"))).toBe(false);
  });

  it("disallows every crawler in robots.txt", async () => {
    const response = await get("https://docs.acme-test.com/robots.txt");
    expect(await response.text()).toContain("Disallow: /");
  });

  it("unfurls a short link as the bound workspace's, and the root as its homepage", async () => {
    const card = await (
      await get("https://docs.acme-test.com/intake", { ua: SLACK })
    ).text();
    expect(card).toContain("acme:intake");
    const home = await (
      await get("https://docs.acme-test.com/", { ua: SLACK })
    ).text();
    expect(home).toContain("acme:welcome");
    const noHome = await (
      await get("https://globex-test.com/", { ua: SLACK })
    ).text();
    expect(noHome).not.toContain("globex:");
    const asked = calls
      .filter((c) => c.url.endsWith("/share/short"))
      .map((c) => JSON.parse(c.body ?? "{}"));
    expect(asked).toEqual([
      { handle: "acme", slug: "intake" },
      { handle: "acme", slug: "welcome", routePath: "/" },
    ]);
  });

  it("gives crawlers the generic card where no public page answers, without asking for a short link", async () => {
    const response = await get("https://docs.acme-test.com/writing/hello", {
      ua: SLACK,
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("acme:");
    expect(html).toContain("<title>Context</title>");
    expect(calls.some((call) => call.url.endsWith("/share/short"))).toBe(false);
    expect(upstreamPaths()).toEqual([]);
  });


  it("refuses anything but reading", async () => {
    const response = await get("https://docs.acme-test.com/intake", {
      method: "POST",
    });
    expect(response.status).toBe(405);
    expect(upstreamPaths()).toEqual([]);
  });
});

describe("which workspace a host serves comes from the host alone", () => {
  it("ignores forwarding headers that name another host", async () => {
    await get("https://docs.acme-test.com/intake", {
      ua: SLACK,
      headers: {
        "X-Forwarded-Host": "globex-test.com",
        Forwarded: "host=globex-test.com",
      },
    });
    const resolved = calls
      .filter((c) => c.url.endsWith("/domain/resolve"))
      .map((c) => JSON.parse(c.body ?? "{}"));
    expect(resolved).toEqual([{ hostname: "docs.acme-test.com" }]);
    const asked = calls
      .filter((c) => c.url.endsWith("/share/short"))
      .map((c) => JSON.parse(c.body ?? "{}"));
    expect(asked).toEqual([{ handle: "acme", slug: "intake" }]);
  });

  it("an unknown host gets the same 404 as a missing page, and nothing else", async () => {
    for (const path of ["/", "/intake", "/_expo/static/js/web/entry-abc.js"]) {
      const response = await get(`https://unknown-test.com${path}`);
      expect(response.status).toBe(404);
    }
    expect(upstreamPaths()).toEqual([]);
  });

  it("an upstream answer that is not a handle is not a site", () => {
    expect(
      siteRoute(new URL("https://x-test.com/intake"), BROWSER, null),
    ).toEqual({ kind: "site-missing" });
  });

  it("fails closed and uncached when the control plane cannot be asked", async () => {
    controlPlaneDown = true;
    const response = await get("https://docs.acme-test.com/intake");
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(upstreamPaths()).toEqual([]);
  });

  it("context.lc itself is untouched by any of this", async () => {
    await get("https://context.lc/@acme/intake");
    expect(calls.some((c) => c.url.endsWith("/domain/resolve"))).toBe(false);
    expect(upstreamPaths()).toEqual(["/@acme/intake"]);
  });
});

function metaContent(html: string, attr: string, name: string): string[] {
  const pattern = new RegExp(`<meta ${attr}="${name}" content="([^"]*)">`, "g");
  return [...html.matchAll(pattern)].map((m) => m[1]!);
}

describe("a website page unfurls as itself", () => {
  it("carries the page's title, its site's name and description, and its own card", async () => {
    const html = await (await get("https://globex-test.com/writing/hello", { ua: SLACK })).text();
    expect(html).toContain("<title>Hello, world</title>");
    expect(metaContent(html, "property", "og:site_name")).toEqual(["Globex"]);
    expect(metaContent(html, "property", "og:description")).toEqual(["The first post."]);
    expect(metaContent(html, "property", "og:url")).toEqual(["https://globex-test.com/writing/hello"]);
    expect(metaContent(html, "property", "og:image")).toEqual([
      "https://globex-test.com/og/page.png?path=%2Fwriting%2Fhello&amp;v=89abcdef",
    ]);
    // Nothing of Context's own card or copy survives on somebody's page.
    expect(html).not.toContain("context.lc/og/card.png");
    expect(html).not.toContain("MCP endpoint");
    expect(calls.find((c) => c.url.endsWith("/site/preview"))?.body).toBe(
      JSON.stringify({ handle: "globex", routePath: "/writing/hello" }),
    );
  });

  it("unfurls the root as the site's home page", async () => {
    const html = await (await get("https://globex-test.com/", { ua: SLACK })).text();
    expect(html).toContain("<title>Globex</title>");
    expect(metaContent(html, "property", "og:url")).toEqual(["https://globex-test.com/"]);
    expect(metaContent(html, "property", "og:image")[0]).toContain("/og/page.png?path=%2F&amp;v=0123abcd");
  });

  it("a page with no drawable card has no image at all, rather than Context's", async () => {
    const html = await (await get("https://globex-test.com/hostile", { ua: SLACK })).text();
    expect(metaContent(html, "property", "og:image")).toEqual([]);
    expect(metaContent(html, "name", "twitter:card")).toEqual(["summary"]);
    expect(html).not.toContain("<script>x()");
    const opens = html.match(/ content="/g) ?? [];
    const complete = html.match(/ content="[^"]*">/g) ?? [];
    expect(complete).toHaveLength(opens.length);
  });

  it("serves the card for the bound workspace only, asking with the checked path", async () => {
    const response = await get("https://globex-test.com/og/page.png?path=%2Fwriting%2Fhello&v=89abcdef", {
      ua: SLACK,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(calls.find((c) => c.url.endsWith("/site/card"))?.body).toBe(
      JSON.stringify({ handle: "globex", routePath: "/writing/hello", version: "89abcdef" }),
    );
  });

  it("a card with no version is a 404 without asking anybody", async () => {
    const response = await get("https://globex-test.com/og/page.png?path=%2Fwriting%2Fhello", { ua: SLACK });
    expect(response.status).toBe(404);
    expect(calls.some((c) => c.url.endsWith("/site/card"))).toBe(false);
  });

  it("a card nobody can draw is a 404, never the product card", async () => {
    const response = await get("https://globex-test.com/og/page.png?path=%2Fnope&v=00000000", { ua: SLACK });
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each(["/og/page.png", "/og/page.png?path=..%2Fx", "/og/page.png?path=%2F.context%2Fx", "/og/page.png?path=a"])(
    "%s never reaches the control plane",
    async (path) => {
      const response = await get(`https://globex-test.com${path}`, { ua: SLACK });
      expect(response.status).toBe(404);
      expect(calls.some((c) => c.url.endsWith("/site/card"))).toBe(false);
    },
  );
});

describe("a website page on context.lc", () => {
  it("unfurls /@handle/<page> as the page, with its card on context.lc", async () => {
    const html = await (await get("https://context.lc/@globex/writing/hello", { ua: SLACK })).text();
    expect(html).toContain("<title>Hello, world</title>");
    expect(metaContent(html, "property", "og:url")).toEqual(["https://context.lc/@globex/writing/hello"]);
    expect(metaContent(html, "property", "og:image")).toEqual([
      "https://context.lc/og/w/@globex.png?path=%2Fwriting%2Fhello&amp;v=89abcdef",
    ]);
  });

  it("serves that card", async () => {
    const response = await get("https://context.lc/og/w/@globex.png?path=%2Fwriting%2Fhello&v=89abcdef", {
      ua: SLACK,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
  });

  it("leaves /@handle alone frozen, asking nobody", async () => {
    const html = await (await get("https://context.lc/@globex", { ua: SLACK })).text();
    expect(html).toContain("<title>Context</title>");
    expect(calls.filter((c) => c.url.startsWith(ENV.CONVEX_ORIGIN))).toEqual([]);
  });
});
