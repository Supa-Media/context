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
 *     /ingest/[...]    -> PostHog, the app's product analytics, carrying only
 *                         an allowlist of headers (analyticsIngest.ts)
 *     /_expo/[...]     -> the Expo web app, cacheable forever
 *     /og/card.png     -> the Worker's own OpenGraph card
 *     /favicon.ico etc -> the Worker's own icons (icons.ts)
 *     /robots.txt      -> allow everything, plain text (icons.ts)
 *     everything else  -> a link-preview crawler gets server-rendered meta
 *                         tags; everyone else gets the Expo web app on EAS
 *                         Hosting, path unchanged
 *   www.context.lc     -> 301 https://context.lc<path><search>
 *
 *   tex.lc, tex-staging.context.lc   (Tex, the texting assistant; texHost.ts)
 *     every apex rule above, path unchanged — the same web app, the same
 *     Convex proxy, the same console — except:
 *     /og/tex-card.png -> Tex's OpenGraph card (served on every host)
 *     /robots.txt      -> the apex's, less /waitlist and /console
 *     a crawler        -> Tex's frozen cards, never Context's copy or a
 *                         context.lc canonical, wherever the apex would have
 *                         given a static card (share, team, short-link and
 *                         website previews are unchanged)
 *     `/` is drawn as the Tex landing by the app itself, from the hostname;
 *     index.ts skips the context.lc homepage snapshot there.
 *   www.tex.lc         -> 301 https://tex.lc<path><search>
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
  CONNECT_SLACK_CARD_PATH,
  GOOGLE_CONNECT_GUIDE_PATH,
  consoleNoteFrom,
  noteLinkFrom,
  NOTE_LINK_PREVIEW,
  previewFor,
  shareCardTokenFrom,
  shortLinkCardFrom,
  shareTokenFrom,
  type PreviewMeta,
} from "./preview";
import { handleSiteFrom, siteCardFrom } from "./preview/sites";
import { downloadFor } from "./download";
export { downloadResponse } from "./download";
import { iconFor, ROBOTS_PATH, type IconName } from "./icons";
import { isTexHost, TEX_APEX, TEX_CARD_PATH, TEX_WWW_HOST, texPreviewFor } from "./texHost";
import { ingestTarget } from "./analyticsIngest";

/** The services this Worker fronts. index.ts maps each to a real origin. */
export type Upstream = "expo" | "convex";

export type RouteDecision =
  | { kind: "redirect"; location: string }
  // The Mac app's dmg on GitHub, a temporary redirect that is never cached.
  // See `download.ts`.
  | { kind: "download"; location: string }
  // Server-rendered OpenGraph/Twitter tags for a link-preview crawler. `meta`
  // is always one of the frozen constants in preview.ts — never anything
  // derived from the request. See that file for why.
  //
  // `robotsHeader`, when present, is sent as `X-Robots-Tag` too. Only Tex's
  // noindex cards set it; context.lc's responses are byte-for-byte as before.
  | { kind: "preview"; meta: PreviewMeta; robotsHeader?: string }
  // A crawler asking for a share link. The token is shape-checked
  // (`shareTokenFrom`) before it gets here, so it is 64 hex characters and
  // nothing else. The caller looks the title up and MUST fall back to
  // GENERIC_PREVIEW on absence, error, or timeout — see index.ts.
  | { kind: "share-preview"; token: string }
  // The card image for a share. Fetched by the same crawler that just asked
  // for the preview HTML, so it sits AHEAD of the crawler check with the other
  // machine endpoints — a crawler asking for a PNG wants the bytes.
  | { kind: "share-card"; token: string }
  | { kind: "short-link-card"; handle: string; slug: string }
  // A crawler asking for a readable team link. Shape-checked before it gets
  // here, so `slug` and `path` are well-formed and nothing an attacker types
  // reaches an upstream unchecked.
  // `link` marks the `/note/@slug/<path>` address, whose untitled card is
  // NOTE_LINK_PREVIEW rather than the product card.
  | { kind: "note-preview"; slug: string; path: string; link?: true }
  // A crawler asking for an address a website may own: the page's own tags
  // when it is a live public page, else the legacy short link at the same
  // address when there is one, else the product card. See `preview/sites.ts`.
  | {
      kind: "site-preview";
      handle: string;
      routePath: string;
      legacySlug?: string;
      /** Where the page lives, for its canonical URL and its card's. */
      origin: string;
      prefix: string;
    }
  | { kind: "site-card"; handle: string; routePath: string; version: string | null }
  | {
      kind: "short-link-preview";
      handle: string;
      slug: string;
      /** Custom-domain root preview: the website route checked before `slug`. */
      routePath?: string;
    }
  // The app's analytics on their way to PostHog. `target` is built from two
  // fixed origins and the path; see `analyticsIngest.ts`.
  | { kind: "ingest"; target: string }
  // The Worker's own OpenGraph card image, served from the bundle.
  | { kind: "og-card" }
  // Tex's card, likewise from the bundle. See `texHost.ts`.
  | { kind: "tex-card" }
  | { kind: "connect-slack-card" }
  | { kind: "google-connect-guide" }
  // The site's favicons, served from the bundle. See `icons.ts`.
  | { kind: "icon"; name: IconName }
  // The apex's robots.txt, plain text from the Worker. See `icons.ts`.
  | { kind: "robots"; tex?: true }
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
    return {
      kind: "redirect",
      location: `https://${APEX}${pathname}${search}`,
    };
  }
  // The same for Tex, and for the same reasons. Exact host only: there is no
  // `*.tex.lc` rule anywhere in this Worker.
  if (hostname === TEX_WWW_HOST) {
    return {
      kind: "redirect",
      location: `https://${TEX_APEX}${pathname}${search}`,
    };
  }
  // Tex's hosts take every rule below unchanged; this flag only picks Tex's
  // robots.txt and Tex's frozen crawler cards. See texHost.ts.
  const tex = isTexHost(hostname);

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

  const ingest = ingestTarget(url);
  if (ingest !== null) return { kind: "ingest", target: ingest };

  if (pathname === OG_CARD_PATH) {
    return { kind: "og-card" };
  }
  // On every platform host, not only Tex's: it is a product image like the
  // one above, and a preview's tags may be read from either origin.
  if (pathname === TEX_CARD_PATH) {
    return { kind: "tex-card" };
  }
  // The card a Slack connect link unfurls with (`preview/meta.ts`).
  if (pathname === CONNECT_SLACK_CARD_PATH) {
    return { kind: "connect-slack-card" };
  }
  // The picture Tex texts with a Google connect link (`apps/mcp/src/tools/workspaces.js`).
  if (pathname === GOOGLE_CONNECT_GUIDE_PATH) {
    return { kind: "google-connect-guide" };
  }

  // The favicons, for the same reason: Google's favicon fetcher is a crawler,
  // and a crawler asking for an icon wants the icon, not an HTML card.
  const icon = iconFor(pathname);
  if (icon !== null) return { kind: "icon", name: icon };

  // robots.txt too: it is the first thing Googlebot fetches, and the crawler
  // branch below would answer it with the HTML product card.
  if (pathname === ROBOTS_PATH) return tex ? { kind: "robots", tex: true } : { kind: "robots" };

  // A download link pasted into Slack is still a download link: ahead of the
  // crawler check, so the unfurler is sent to the file rather than a card.
  const download = downloadFor(pathname);
  if (download !== null) return { kind: "download", location: download };

  // Before the crawler check, like `/og/card.png` above and for the same
  // reason: this is the image the preview tags point at, and it is requested
  // with the same User-Agent that triggered them.
  const cardToken = shareCardTokenFrom(pathname);
  if (cardToken !== null) {
    return { kind: "share-card", token: cardToken };
  }

  // A short link's card, for the same reason and at the same point in the
  // order: it is the image the preview tags point at, requested with the same
  // User-Agent that triggered them. Its address carries a name rather than a
  // token, which is the whole reason short links can have a card at all — see
  // `previewForShortLink`.
  const shortCard = shortLinkCardFrom(pathname);
  if (shortCard !== null) {
    return {
      kind: "short-link-card",
      handle: shortCard.handle,
      slug: shortCard.slug,
    };
  }

  // A website page's card, addressed by the handle and path the crawler used.
  const siteCard = siteCardFrom(url, false);
  if (siteCard !== null && siteCard.handle !== null) {
    return {
      kind: "site-card",
      handle: siteCard.handle,
      routePath: siteCard.routePath,
      version: siteCard.version,
    };
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
    // A readable team link. Guessable, and answered only for notes the owner
    // has explicitly linked — see `consoleNoteFrom`.
    const note = consoleNoteFrom(url);
    if (note !== null) {
      return { kind: "note-preview", slug: note.slug, path: note.path };
    }
    // The note link Tex texts. The same answer as the console link, and the
    // same constant card for every address it refuses.
    const noteLink = noteLinkFrom(url);
    if (noteLink !== null) {
      return noteLink.note === null
        ? { kind: "preview", meta: NOTE_LINK_PREVIEW }
        : { kind: "note-preview", slug: noteLink.note.slug, path: noteLink.note.path, link: true };
    }

    // A website address, `/@seyi/writing`. It unfurls as the page
    // only when that is a live public page of a site its owner turned on,
    // which is what the address already shows anyone who opens it; a short
    // link at the same address is asked about next, exactly as the app
    // resolves it, and everything else is the product card. The short link's
    // own bound is unchanged: the probe space is names the owner typed. `/@seyi`
    // alone is not one of these and stays frozen; see `handleSiteFrom`.
    const site = handleSiteFrom(url);
    if (site !== null) {
      return {
        kind: "site-preview",
        handle: site.handle,
        routePath: site.routePath,
        ...(site.legacySlug === null ? {} : { legacySlug: site.legacySlug }),
        origin: `https://${APEX}`,
        prefix: `/@${site.handle}`,
      };
    }

    // The one path whose card is not decided here. A share token is
    // unguessable and was handed out deliberately, so its link may carry the
    // note's title — see `previewForShare`. Everything else, including every
    // name-bearing path, still resolves against the static table and cannot
    // reach an upstream.
    const shareToken = shareTokenFrom(pathname);
    if (shareToken !== null) {
      return { kind: "share-preview", token: shareToken };
    }
    // A Tex host answers from Tex's own frozen table — the same rule, with
    // Tex's words and a tex.lc canonical. The host only picks the table; it
    // never reaches the output.
    if (tex) {
      const meta = texPreviewFor(pathname);
      return meta.robots === undefined
        ? { kind: "preview", meta }
        : { kind: "preview", meta, robotsHeader: meta.robots };
    }
    return { kind: "preview", meta: previewFor(pathname) };
  }

  return { kind: "proxy", upstream: "expo", path };
}
