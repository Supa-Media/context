import { describe, expect, it } from "vitest";
import { GENERIC_PREVIEW, previewFor } from "./preview";
import { route } from "./route";
import { TEX_GENERIC_PREVIEW, TEX_HOME_PREVIEW, TEX_WAITLIST_PREVIEW } from "./texHost";

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

  it("robots.txt is the Worker's own plain text, crawler or not", () => {
    // Googlebot reads it before anything else. Left to the crawler branch it
    // was handed the HTML product card, and a person's browser got the SPA
    // shell: Google reads neither as rules, so a real file says it plainly.
    const googlebot = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
    for (const ua of [googlebot, SLACKBOT_UA, BROWSER_UA, undefined]) {
      expect(at("https://context.lc/robots.txt", ua)).toEqual({ kind: "robots" });
    }
    expect(at("https://context.lc/robots.txt?x=1", BROWSER_UA)).toEqual({ kind: "robots" });
    expect(at("https://context.lc/x/robots.txt", BROWSER_UA).kind).toBe("proxy");
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

describe("route: a short link's card is an image, not a page", () => {
  it("is matched before the crawler check, like every other card", () => {
    // The image the preview tags point at is fetched with the **same**
    // User-Agent that triggered them, so a card address that only resolved for
    // a crawler would 404 for a browser opening the picture directly — and one
    // that only resolved for a browser would never reach an unfurler at all.
    for (const ua of [undefined, BROWSER_UA, SLACKBOT_UA]) {
      expect(at("https://context.lc/og/n/@seyi/intake.png?v=abcd1234", ua)).toEqual({
        kind: "short-link-card",
        handle: "seyi",
        slug: "intake",
      });
    }
  });

  it("an address that could never name a card is an ordinary page", () => {
    // Never a card, and therefore never an upstream POST. A crawler still gets
    // preview tags for it, which is the existing behaviour for any path that
    // is not one of the special cases.
    expect(at("https://context.lc/og/n/seyi/intake.png", BROWSER_UA)).not.toMatchObject({
      kind: "short-link-card",
    });
    expect(at("https://context.lc/og/n/@seyi/a/b.png", BROWSER_UA)).not.toMatchObject({
      kind: "short-link-card",
    });
  });

  it("the short link itself still routes to a preview, not to its card", () => {
    // A website page is asked about first, as the app resolves the address;
    // the short link is the fallback at the same address.
    expect(at("https://context.lc/@seyi/intake", SLACKBOT_UA)).toEqual({
      kind: "site-preview",
      handle: "seyi",
      routePath: "/intake",
      legacySlug: "intake",
      origin: "https://context.lc",
      prefix: "/@seyi",
    });
  });
});

describe("route: Tex's hosts are the apex, path for path", () => {
  it.each(["/", "/console/@x/a?note=b", "/x?y=1"])(
    "www.tex.lc%s folds onto https://tex.lc, path and query kept",
    (path) => {
      expect(at(`https://www.tex.lc${path}`)).toEqual({
        kind: "redirect",
        location: `https://tex.lc${path}`,
      });
      // A crawler too, so the card it caches is the apex's.
      expect(at(`https://www.tex.lc${path}`, SLACKBOT_UA)).toMatchObject({ kind: "redirect" });
    },
  );

  it.each(["tex.lc", "tex-staging.context.lc"])("%s proxies a console deep link unchanged", (host) => {
    expect(at(`https://${host}/console/@x/a?note=b`, BROWSER_UA)).toEqual({
      kind: "proxy",
      upstream: "expo",
      path: "/console/@x/a?note=b",
    });
  });

  it.each(["tex.lc", "tex-staging.context.lc"])("%s sends auth to Convex unchanged", (host) => {
    expect(at(`https://${host}/api/auth/signin/x?redirectTo=%2F`)).toEqual({
      kind: "proxy",
      upstream: "convex",
      path: "/api/auth/signin/x?redirectTo=%2F",
    });
  });

  it("the apex's machine routes answer the same on tex.lc", () => {
    expect(at("https://tex.lc/_expo/static/js/web/entry-abc.js", SLACKBOT_UA)).toEqual({
      kind: "proxy",
      upstream: "expo",
      path: "/_expo/static/js/web/entry-abc.js",
      cache: "immutable",
    });
    expect(at("https://tex.lc/og/card.png", SLACKBOT_UA)).toEqual({ kind: "og-card" });
    expect(at("https://tex.lc/favicon.ico", SLACKBOT_UA)).toEqual({ kind: "icon", name: "ico" });
    for (const path of ["/invite/abc", "/s/abc", "/signin?email=a"]) {
      expect(at(`https://tex.lc${path}`, BROWSER_UA)).toEqual({ kind: "proxy", upstream: "expo", path });
    }
  });

  it("the Tex card is served on both apexes", () => {
    expect(at("https://tex.lc/og/tex-card.png", SLACKBOT_UA)).toEqual({ kind: "tex-card" });
    expect(at("https://context.lc/og/tex-card.png", BROWSER_UA)).toEqual({ kind: "tex-card" });
  });

  it("robots.txt is Tex's on a Tex host and the apex's on context.lc", () => {
    expect(at("https://tex.lc/robots.txt")).toEqual({ kind: "robots", tex: true });
    expect(at("https://tex-staging.context.lc/robots.txt")).toEqual({ kind: "robots", tex: true });
    expect(at("https://context.lc/robots.txt")).toEqual({ kind: "robots" });
  });

  it("a crawler on a Tex host gets Tex's frozen cards, and context.lc keeps its own", () => {
    expect(at("https://tex.lc/", SLACKBOT_UA)).toEqual({ kind: "preview", meta: TEX_HOME_PREVIEW });
    expect(at("https://tex.lc/waitlist?id=1", SLACKBOT_UA)).toEqual({
      kind: "preview",
      meta: TEX_WAITLIST_PREVIEW,
      robotsHeader: "noindex, nofollow",
    });
    for (const path of ["/login", "/@nobody", "/console/@x/a", "/whatever"]) {
      expect(at(`https://tex.lc${path}`, SLACKBOT_UA)).toEqual({
        kind: "preview",
        meta: TEX_GENERIC_PREVIEW,
        robotsHeader: "noindex, nofollow",
      });
    }
    expect(at("https://context.lc/", SLACKBOT_UA)).toEqual({ kind: "preview", meta: previewFor("/") });
    expect(at("https://context.lc/whatever", SLACKBOT_UA)).toEqual({ kind: "preview", meta: GENERIC_PREVIEW });
  });

  it("paths with their own preview logic keep it on a Tex host", () => {
    const token = "a".repeat(64);
    expect(at(`https://tex.lc/s/${token}`, SLACKBOT_UA)).toEqual({ kind: "share-preview", token });
    expect(at("https://tex.lc/@seyi/intake", SLACKBOT_UA)).toMatchObject({ kind: "site-preview" });
  });

  it("is never a wildcard: another tex.lc subdomain is not Tex", () => {
    expect(at("https://app.tex.lc/", SLACKBOT_UA)).toEqual({ kind: "preview", meta: previewFor("/") });
    expect(at("https://app.tex.lc/robots.txt")).toEqual({ kind: "robots" });
  });
});
