import { describe, expect, it } from "vitest";
import { GENERIC_PREVIEW, previewFor } from "./preview";
import { route } from "./route";

function at(url: string, userAgent?: string) {
  return route(new URL(url), userAgent);
}

/** A representative desktop browser. Nothing about it says "crawler". */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const SLACKBOT_UA = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";

describe("route: the apex is the Expo web app", () => {
  it.each(["/", "/onboarding", "/dashboard", "/settings/storage"])(
    "%s goes to the Expo upstream with the path unchanged",
    (path) => {
      expect(at(`https://context.lc${path}`)).toEqual({
        kind: "proxy",
        upstream: "expo",
        path,
      });
    },
  );

  it("preserves the query string", () => {
    expect(at("https://context.lc/connect?provider=r2&step=2")).toEqual({
      kind: "proxy",
      upstream: "expo",
      path: "/connect?provider=r2&step=2",
    });
  });

  it("does not rewrite the path — there is no app prefix to strip", () => {
    // publicworship.life mounts its app under /os because it shares the apex
    // with a landing site. context.lc does not: the app IS the apex, and a
    // deep link has to arrive at EAS Hosting byte-identical or client-side
    // routing lands on the wrong screen.
    expect(at("https://context.lc/w/acme/1-projects/foo.md")).toEqual({
      kind: "proxy",
      upstream: "expo",
      path: "/w/acme/1-projects/foo.md",
    });
  });
});

describe("route: the auth flow's HTTP routes go to Convex", () => {
  it.each([
    "/api/auth/signin/resend-otp",
    "/api/auth/callback/github",
    "/api/auth/callback/github/redirect",
  ])("%s goes to the Convex upstream unchanged", (path) => {
    expect(at(`https://context.lc${path}`)).toEqual({
      kind: "proxy",
      upstream: "convex",
      path,
    });
  });

  it("preserves the query string an OAuth callback arrives with", () => {
    expect(
      at("https://context.lc/api/auth/callback/github?code=abc&state=xyz"),
    ).toEqual({
      kind: "proxy",
      upstream: "convex",
      path: "/api/auth/callback/github?code=abc&state=xyz",
    });
  });

  it("leaves the rest of /api/ with the web app", () => {
    // Expo Router serves its own API routes at /api/<name>. A broad "/api/"
    // rule would steal them the day someone adds one, so the Convex prefix is
    // "/api/auth/" and nothing wider.
    expect(at("https://context.lc/api/health")).toEqual({
      kind: "proxy",
      upstream: "expo",
      path: "/api/health",
    });
  });

  it("does not match a path that merely starts with the same letters", () => {
    expect(at("https://context.lc/api/authors")).toEqual({
      kind: "proxy",
      upstream: "expo",
      path: "/api/authors",
    });
  });

  it("leaves /.well-known/ with the web app", () => {
    // The OIDC documents are fetched from the *.convex.site origin directly by
    // Convex itself (auth.config.ts sets the issuer to CONVEX_SITE_URL), and
    // the apex's /.well-known/ namespace is where universal-link association
    // files have to live. See the note in route.ts.
    expect(at("https://context.lc/.well-known/jwks.json")).toEqual({
      kind: "proxy",
      upstream: "expo",
      path: "/.well-known/jwks.json",
    });
    expect(
      at("https://context.lc/.well-known/apple-app-site-association"),
    ).toEqual({
      kind: "proxy",
      upstream: "expo",
      path: "/.well-known/apple-app-site-association",
    });
  });
});

describe("route: edge cache hint for Expo's hashed bundle output", () => {
  it("/_expo/static/js/x.js is immutable", () => {
    expect(at("https://context.lc/_expo/static/js/x.js")).toEqual({
      kind: "proxy",
      upstream: "expo",
      path: "/_expo/static/js/x.js",
      cache: "immutable",
    });
  });

  it("an app route gets no cache hint", () => {
    expect(at("https://context.lc/dashboard")).toEqual({
      kind: "proxy",
      upstream: "expo",
      path: "/dashboard",
    });
  });

  it("a path that only looks like the bundle prefix gets no cache hint", () => {
    // Caching a non-hashed path for a year is unrecoverable without a purge,
    // so the prefix match has to include the trailing slash.
    expect(at("https://context.lc/_expose")).toEqual({
      kind: "proxy",
      upstream: "expo",
      path: "/_expose",
    });
  });

  it("never marks a Convex response immutable", () => {
    // Belt and braces: /api/auth/ is matched first, so even a path that also
    // starts with the bundle prefix could not be cached for a year.
    expect(at("https://context.lc/api/auth/signin/x")).toEqual({
      kind: "proxy",
      upstream: "convex",
      path: "/api/auth/signin/x",
    });
  });
});

describe("route: www redirects to the apex", () => {
  it("the root redirects to the apex root", () => {
    expect(at("https://www.context.lc/")).toEqual({
      kind: "redirect",
      location: "https://context.lc/",
    });
  });

  it("a path is preserved", () => {
    expect(at("https://www.context.lc/dashboard")).toEqual({
      kind: "redirect",
      location: "https://context.lc/dashboard",
    });
  });

  it("a query string is preserved", () => {
    expect(at("https://www.context.lc/connect?provider=s3")).toEqual({
      kind: "redirect",
      location: "https://context.lc/connect?provider=s3",
    });
  });

  it("redirects the auth routes too, rather than proxying them", () => {
    // One canonical origin for the app means one origin in cookies, CORS, and
    // OAuth redirect_uri allow-lists.
    expect(at("https://www.context.lc/api/auth/callback/github")).toEqual({
      kind: "redirect",
      location: "https://context.lc/api/auth/callback/github",
    });
  });
});

describe("route: crawlers get a preview, people get the app", () => {
  it("a browser on a context link is proxied to the app, unchanged", () => {
    expect(at("https://context.lc/@alice", BROWSER_UA)).toEqual({
      kind: "proxy",
      upstream: "expo",
      path: "/@alice",
    });
  });

  it("no User-Agent at all is treated as a person", () => {
    // curl, a health check, a scripted client. They get the SPA, same as a
    // browser — which tells them nothing a browser would not already see.
    expect(at("https://context.lc/@alice")).toEqual({
      kind: "proxy",
      upstream: "expo",
      path: "/@alice",
    });
  });

  it("a crawler on a context link gets the generic preview", () => {
    expect(at("https://context.lc/@alice", SLACKBOT_UA)).toEqual({
      kind: "preview",
      meta: GENERIC_PREVIEW,
    });
  });

  it("a crawler on the landing page gets the landing page's own card", () => {
    expect(at("https://context.lc/", SLACKBOT_UA)).toEqual({
      kind: "preview",
      meta: previewFor("/"),
    });
    expect(previewFor("/")).not.toBe(GENERIC_PREVIEW);
  });

  it("the query string never reaches a preview decision", () => {
    // previewFor is given the pathname only, so two links that differ solely
    // in their query are the same card.
    expect(at("https://context.lc/@alice?ref=slack", SLACKBOT_UA)).toEqual(
      at("https://context.lc/@alice", SLACKBOT_UA),
    );
  });
});

describe("route: machine endpoints are decided before the crawler check", () => {
  it("a crawler asking for the OG card gets the card, not an HTML card", () => {
    // The crawler that was handed the preview immediately fetches the image it
    // points at, with the same User-Agent. If the crawler branch came first,
    // og:image would serve HTML and every unfurl would lose its picture.
    expect(at("https://context.lc/og/card.png", SLACKBOT_UA)).toEqual({
      kind: "og-card",
    });
    expect(at("https://context.lc/og/card.png", BROWSER_UA)).toEqual({
      kind: "og-card",
    });
  });

  it("a crawler on an auth route still goes to Convex", () => {
    expect(at("https://context.lc/api/auth/callback/github", SLACKBOT_UA)).toEqual(
      { kind: "proxy", upstream: "convex", path: "/api/auth/callback/github" },
    );
  });

  it("a crawler on the JS bundle still gets the bundle", () => {
    expect(at("https://context.lc/_expo/static/js/x.js", SLACKBOT_UA)).toEqual({
      kind: "proxy",
      upstream: "expo",
      path: "/_expo/static/js/x.js",
      cache: "immutable",
    });
  });

  it("www still redirects, crawler or not", () => {
    // The crawler follows the 301 and caches the card under the apex, which is
    // the URL we want people to see attributed in an unfurl.
    expect(at("https://www.context.lc/@alice", SLACKBOT_UA)).toEqual({
      kind: "redirect",
      location: "https://context.lc/@alice",
    });
  });
});

describe("route: an unexpected host falls back to the apex rules", () => {
  it("the workers.dev preview URL behaves like the apex", () => {
    // Not a security boundary — it just keeps the preview deployment usable
    // for debugging instead of dead.
    expect(at("https://context-router.example.workers.dev/dashboard")).toEqual({
      kind: "proxy",
      upstream: "expo",
      path: "/dashboard",
    });
  });
});
