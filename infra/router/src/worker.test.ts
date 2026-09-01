/**
 * The thin handler: turning a RouteDecision into a Response.
 *
 * route.test.ts and preview.test.ts cover the decisions and the rendering as
 * pure functions. What can only be checked here is the wiring — that the
 * User-Agent reaches the router at all, that a preview really is served
 * without touching the network, and that a person is proxied through untouched.
 *
 * `fetch` is stubbed in every test, so nothing in this file can reach the
 * network even by mistake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";

const ENV = {
  EXPO_ORIGIN: "https://context.expo.app",
  CONVEX_ORIGIN: "https://example-deployment.convex.site",
};

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const CRAWLER_UAS = {
  Slackbot: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  Twitterbot: "Twitterbot/1.0",
  facebookexternalhit: "facebookexternalhit/1.1",
  WhatsApp: "WhatsApp/2.23.20.0 A",
  Discordbot: "Mozilla/5.0 (compatible; Discordbot/2.0)",
  LinkedInBot: "LinkedInBot/1.0 (compatible; Mozilla/5.0)",
  TelegramBot: "TelegramBot (like TwitterBot)",
  Applebot: "Mozilla/5.0 (compatible; Applebot/0.1)",
  Googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1)",
  bingbot: "Mozilla/5.0 (compatible; bingbot/2.0)",
};

/**
 * Stands in for the network. Tests that expect a passthrough swap in their own
 * implementation; every other test leaves this one in place, so any stray
 * upstream call fails loudly instead of silently succeeding.
 */
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(() => {
    throw new Error("upstream fetch attempted");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A stand-in `ExecutionContext`.
 *
 * `waitUntil` runs the promise rather than discarding it, so a test can await
 * the cache write the card path schedules; `passThroughOnException` is inert
 * because nothing here uses it.
 */
const CTX = {
  waitUntil: (promise: Promise<unknown>) => {
    void promise;
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function get(path: string, userAgent?: string): Promise<Response> {
  const headers = userAgent ? { "User-Agent": userAgent } : undefined;
  return worker.fetch(
    new Request(`https://context.lc${path}`, { headers }),
    ENV,
    CTX,
  ) as Promise<Response>;
}

describe("every crawler gets server-rendered tags", () => {
  it.each(Object.entries(CRAWLER_UAS))("%s", async (_name, ua) => {
    const response = await get("/", ua);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/html; charset=utf-8",
    );

    const html = await response.text();
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain('<meta property="og:site_name" content="Context">');
    expect(html).toContain(
      '<meta property="og:image" content="https://context.lc/og/card.png">',
    );
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image">',
    );
    expect(html).toContain('<link rel="canonical"');
  });

  it("never calls upstream to build a preview", async () => {
    // The point of the whole design: there is no lookup, so there is nothing
    // to leak and nothing to time. If this ever fails, someone has added a
    // workspace fetch to an unauthenticated code path.
    for (const path of ["/", "/login", "/@alice", "/@nobody", "/whatever"]) {
      await get(path, CRAWLER_UAS.Slackbot);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not let a shared cache hand the crawler shell to a person", async () => {
    const response = await get("/@alice", CRAWLER_UAS.Slackbot);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toBe("User-Agent");
  });
});

describe("a person gets the app, untouched", () => {
  beforeEach(() => {
    fetchSpy.mockImplementation(
      (request: Request) =>
        new Response(`proxied:${request.url}`, {
          headers: { "Content-Type": "text/html" },
        }),
    );
  });

  it.each(["/", "/login", "/@alice", "/console/storage"])(
    "a browser on %s is proxied to the Expo origin",
    async (path) => {
      const response = await get(path, BROWSER_UA);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await expect(response.text()).resolves.toBe(
        `proxied:https://context.expo.app${path}`,
      );
    },
  );

  it("a request with no User-Agent is proxied, not previewed", async () => {
    const response = await get("/@alice");
    await expect(response.text()).resolves.toContain("proxied:");
  });

  it("passes the query string through", async () => {
    const response = await get("/login?next=%2Fconsole", BROWSER_UA);
    await expect(response.text()).resolves.toBe(
      "proxied:https://context.expo.app/login?next=%2Fconsole",
    );
  });
});

describe("byte-identical previews for context links", () => {
  // The same guarantee preview.test.ts pins on the pure renderer, asserted
  // once more end to end — through the router, the handler, and the response
  // body — because that is the artefact an attacker actually receives.
  it("/@alice, /@bob and /@does-not-exist-anywhere are indistinguishable", async () => {
    const [alice, bob, nobody] = await Promise.all(
      ["/@alice", "/@bob", "/@does-not-exist-anywhere"].map(async (path) => {
        const response = await get(path, CRAWLER_UAS.Slackbot);
        return {
          status: response.status,
          contentType: response.headers.get("Content-Type"),
          cacheControl: response.headers.get("Cache-Control"),
          vary: response.headers.get("Vary"),
          body: await response.text(),
        };
      }),
    );

    expect(alice).toEqual(bob);
    expect(alice).toEqual(nobody);
    expect(alice!.body).toContain("Sign in to open this link.");
    expect(alice!.body).not.toContain("alice");
  });
});

describe("the OG card image", () => {
  it("is served as PNG bytes from the Worker itself", async () => {
    const response = await get("/og/card.png", CRAWLER_UAS.Slackbot);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("is the same image a browser gets", async () => {
    const response = await get("/og/card.png", BROWSER_UA);
    expect(response.headers.get("Content-Type")).toBe("image/png");
  });
});

describe("machine routes are unaffected by the crawler branch", () => {
  it("a crawler on an auth route is still proxied to Convex", async () => {
    fetchSpy.mockImplementation(
      (request: Request) => new Response(`proxied:${request.url}`),
    );

    const response = await get(
      "/api/auth/callback/github?code=abc",
      CRAWLER_UAS.Googlebot,
    );

    await expect(response.text()).resolves.toBe(
      "proxied:https://example-deployment.convex.site/api/auth/callback/github?code=abc",
    );
  });

  it("www redirects a crawler to the apex", async () => {
    const response = (await worker.fetch(
      new Request("https://www.context.lc/@alice", {
        headers: { "User-Agent": CRAWLER_UAS.Slackbot },
        redirect: "manual",
      }),
      ENV,
      CTX,
    )) as Response;

    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("https://context.lc/@alice");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * WHAT THE EDGE MAKES OF `openToAnyone`, WHICH NOTHING WAS CHECKING.
 *
 * `shareTitle` reads the field strictly — `=== true` — and its comment says
 * why: an upstream older than this deployment, newer than it, or compromised
 * must send the reader to sign in rather than promise them an open door. That
 * is the direction the whole file falls in.
 *
 * Nothing tested it. Relaxing that one expression to `!== false` passed all 252
 * checks, and would have made every share card — including the ones for links
 * that genuinely need an account — tell strangers "Open it — no account
 * needed". The `previewForShare` default is caught incidentally by two
 * description assertions; the *parsing* was not guarded at all, which is the
 * half an upstream change actually moves.
 *
 * Driven through the real worker with a stubbed upstream, so it covers the
 * wiring as well as the expression.
 */
describe("the edge only promises an open link when upstream says so", () => {
  const OPEN = /no account needed/i;
  const SIGN_IN = /sign in to read it/i;
  const TOKEN = "a".repeat(64);

  function upstreamReturns(payload: unknown): void {
    fetchSpy.mockImplementation(
      () =>
        new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json" },
        }),
    );
  }

  it("says no account is needed when upstream says exactly true", async () => {
    upstreamReturns({ title: "Chapter transition", openToAnyone: true });
    const html = await (await get(`/s/${TOKEN}`, CRAWLER_UAS.Slackbot)).text();
    expect(html).toMatch(OPEN);
  });

  it.each([
    ["the field is absent", { title: "Chapter transition" }],
    ["it is false", { title: "Chapter transition", openToAnyone: false }],
    ["it is a truthy non-boolean", { title: "Chapter transition", openToAnyone: "yes" }],
    ["it is 1", { title: "Chapter transition", openToAnyone: 1 }],
    ["it is null", { title: "Chapter transition", openToAnyone: null }],
  ])("asks for a sign-in when %s", async (_why, payload) => {
    upstreamReturns(payload);
    const html = await (await get(`/s/${TOKEN}`, CRAWLER_UAS.Slackbot)).text();
    expect(html, "an unknown must not become a promise of access").not.toMatch(OPEN);
    expect(html).toMatch(SIGN_IN);
  });

  it("a title-less share is the generic card whatever the flag says", async () => {
    upstreamReturns({ title: null, openToAnyone: true });
    const html = await (await get(`/s/${TOKEN}`, CRAWLER_UAS.Slackbot)).text();
    expect(html).not.toMatch(OPEN);
  });
});
