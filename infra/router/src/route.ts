/**
 * Pure routing logic for the context-router Cloudflare Worker.
 *
 * Free of any Workers-runtime APIs (Request/Response/fetch) *and* of any
 * configuration, so it can be unit-tested with plain `URL` objects under
 * Vitest/Node. It decides WHICH upstream a request belongs to and WHAT path to
 * ask for; `src/index.ts` resolves an upstream to a real origin and does the
 * network work.
 *
 * Why a Worker in front at all: EAS Hosting only attaches custom domains on a
 * paid plan, so the Expo web app lives at its `*.expo.app` origin and this
 * Worker makes https://context.lc the address people actually use. Same
 * pattern as publicworship.life's pw-router (see ~/Code/events-os).
 *
 * The routing table:
 *
 *   context.lc (apex)
 *     /api/auth/[...]  -> Convex HTTP actions, path unchanged
 *     /_expo/[...]     -> the Expo web app, cacheable forever
 *     /og/card.png     -> the Worker's own OpenGraph card
 *     everything else  -> a link-preview crawler gets server-rendered meta
 *                         tags; everyone else gets the Expo web app on EAS
 *                         Hosting, path unchanged
 *   www.context.lc     -> 301 https://context.lc<path><search>
 *
 * Deliberately NOT here:
 *
 *   mcp.context.lc     the MCP gateway (apps/mcp) is its own Worker on its own
 *                      custom domain. It never passes through this one — a
 *                      customer's storage credentials should not travel one
 *                      hop further than they have to.
 *   <user>@context.lc  Cloudflare Email Routing on the apex. Email Routing is
 *                      MX-level and never touches HTTP, so it coexists with
 *                      this Worker on the same hostname with no interaction.
 */

import {
  isCrawler,
  OG_CARD_PATH,
  previewFor,
  shareCardTokenFrom,
  shareTokenFrom,
  type PreviewMeta,
} from "./preview";

/** The services this Worker fronts. index.ts maps each to a real origin. */
export type Upstream = "expo" | "convex";

export type RouteDecision =
  | { kind: "redirect"; location: string }
  // Server-rendered OpenGraph/Twitter tags for a link-preview crawler. `meta`
  // is always one of the frozen constants in preview.ts — never anything
  // derived from the request. See that file for why.
  | { kind: "preview"; meta: PreviewMeta }
  // A crawler asking for a share link. The token is shape-checked
  // (`shareTokenFrom`) before it gets here, so it is 64 hex characters and
  // nothing else. The caller looks the title up and MUST fall back to
  // GENERIC_PREVIEW on absence, error, or timeout — see index.ts.
  | { kind: "share-preview"; token: string }
  // The card image for a share. Fetched by the same crawler that just asked
  // for the preview HTML, so it sits AHEAD of the crawler check with the other
  // machine endpoints — a crawler asking for a PNG wants the bytes.
  | { kind: "share-card"; token: string }
  // The Worker's own OpenGraph card image, served from the bundle.
  | { kind: "og-card" }
  // `path` is the full path + query to request from the upstream. It is never
  // rewritten today, but naming it separately keeps the tests honest about
  // that and makes a future prefix rule a one-line change.
  //
  // `cache: "immutable"` marks content-hashed build output that is safe to
  // cache at the edge forever; index.ts turns it into a `cf` cache hint.
  | { kind: "proxy"; upstream: Upstream; path: string; cache?: "immutable" };

export const APEX = "context.lc";
export const WWW_HOST = "www.context.lc";

/**
 * Paths the apex hands to Convex instead of to the Expo web app.
 *
 * Kept in sync BY HAND with apps/convex/http.ts, which today registers exactly
 * one thing: `auth.addHttpRoutes(http)` from @convex-dev/auth. That adds
 * `/api/auth/signin/*` and `/api/auth/callback/*` (plus two `/.well-known/`
 * documents, which are deliberately excluded — see below).
 *
 * NARROW ON PURPOSE. `/api/` as a whole would be wrong: Expo Router serves its
 * own API routes (`app/api/foo+api.ts`) at `/api/foo` on EAS Hosting, so a
 * broad prefix would silently steal them the day someone adds one. Every entry
 * here is a path Convex actually owns.
 *
 * When apps/convex/http.ts grows explicit routes of its own, add them here in
 * the same commit — and consider porting events-os's
 * `infra/router/src/drift.test.ts`, which parses http.ts's route literals and
 * fails when this list falls behind. That guard exists because a missing
 * prefix is not a degraded experience, it is a dead link: the Worker serves
 * the web app's 404 and Convex is never consulted.
 */
export const CONVEX_PREFIXES = ["/api/auth/"] as const;

/**
 * `/.well-known/openid-configuration` and `/.well-known/jwks.json` are
 * registered by @convex-dev/auth but are NOT routed here, for two reasons:
 *
 *  1. Nobody asks context.lc for them. `apps/convex/auth.config.ts` sets the
 *     issuer to `CONVEX_SITE_URL`, so Convex fetches its own JWKS from the
 *     `*.convex.site` origin directly. Proxying them through the apex would
 *     publish a second, unused copy of the discovery document.
 *  2. The apex `/.well-known/` namespace belongs to the web app — it is where
 *     `apple-app-site-association` and `assetlinks.json` have to live if
 *     universal links are ever turned on (app.config.js's `associatedDomains`
 *     is empty today). Handing the whole prefix to Convex would foreclose that.
 */

/** Expo's content-hashed bundle output: the filename changes when the bytes
 *  do, so it is safe to cache at the edge indefinitely. */
const IMMUTABLE_PREFIX = "/_expo/";

function isConvexPath(pathname: string): boolean {
  return CONVEX_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Decide what to do with a request.
 *
 * `userAgent` is the request's `User-Agent` header, or nothing. It is used for
 * exactly one thing — telling a link-preview crawler apart from a person — and
 * it can only ever *add* the preview branch. Omit it and every request routes
 * as it did before previews existed.
 */
export function route(url: URL, userAgent?: string | null): RouteDecision {
  const { hostname, pathname, search } = url;

  // Checked before the path rules on purpose: one canonical origin for the app
  // means one origin in cookies, CORS, and OAuth redirect_uri allow-lists.
  // Crawlers are redirected too, so the card they cache is the apex's.
  if (hostname === WWW_HOST) {
    return { kind: "redirect", location: `https://${APEX}${pathname}${search}` };
  }

  // The apex — and any other host that reaches this Worker, e.g. its
  // workers.dev preview URL — gets the apex's path rules.
  const path = `${pathname}${search}`;

  // The three checks below sit AHEAD of the crawler check on purpose: they are
  // machine endpoints, and a crawler that asked for one wants the bytes, not
  // an HTML card. In particular a crawler fetching /og/card.png must get the
  // image — it arrives with the same User-Agent that triggered the preview.
  if (isConvexPath(pathname)) {
    return { kind: "proxy", upstream: "convex", path };
  }

  if (pathname === OG_CARD_PATH) {
    return { kind: "og-card" };
  }

  // Before the crawler check, like `/og/card.png` above and for the same
  // reason: this is the image the preview tags point at, and it is requested
  // with the same User-Agent that triggered them.
  const cardToken = shareCardTokenFrom(pathname);
  if (cardToken !== null) {
    return { kind: "share-card", token: cardToken };
  }

  if (pathname.startsWith(IMMUTABLE_PREFIX)) {
    return { kind: "proxy", upstream: "expo", path, cache: "immutable" };
  }

  // Everything left is a page. Crawlers do not run JavaScript, so the SPA's
  // single index.html would unfurl every URL identically and wrongly; they get
  // real tags instead. `previewFor` reads only the path, and only to look it
  // up in a static table — it never consults an upstream, so nothing about the
  // requested name reaches the response. See preview.ts.
  if (isCrawler(userAgent)) {
    // The one path whose card is not decided here. A share token is
    // unguessable and was handed out deliberately, so its link may carry the
    // note's title — see `previewForShare`. Everything else, including every
    // name-bearing path, still resolves against the static table and cannot
    // reach an upstream.
    const shareToken = shareTokenFrom(pathname);
    if (shareToken !== null) {
      return { kind: "share-preview", token: shareToken };
    }
    return { kind: "preview", meta: previewFor(pathname) };
  }

  return { kind: "proxy", upstream: "expo", path };
}
