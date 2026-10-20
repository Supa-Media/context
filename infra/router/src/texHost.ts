/**
 * Tex's own addresses: https://tex.lc, and the staging host that stands in for
 * it before the real domain is attached.
 *
 * Tex, the texting assistant, is not a second app. tex.lc serves the same
 * Expo web export as context.lc — the same bundle through the same `ASSETS`
 * binding, the same Convex backend behind the same `/api/auth/*` proxy, the
 * same console at `/console/...` — so a person who signs in on tex.lc is in
 * the same account, on the same origin rules, as on context.lc. The one thing
 * that differs is what `/` draws, and the app decides that itself from
 * `window.location.hostname`. Nothing is iframed and nothing is redirected to
 * context.lc: an OAuth or magic-link round trip that started on tex.lc has to
 * finish on tex.lc, or the session lands on the wrong origin.
 *
 * So the Worker's whole share of the job is small, and it lives here:
 *
 *  - which hostnames are Tex (an exact list, never a `*.tex.lc` wildcard —
 *    a wildcard is a promise that every future subdomain is ours to route);
 *  - `www.tex.lc` folding onto the apex, like `www.context.lc`;
 *  - what a link-preview crawler is told on a Tex host, which must be Tex and
 *    never Context's homepage copy or a context.lc canonical;
 *  - robots.txt, which keeps the personal waitlist page and the console out
 *    of search;
 *  - and, in index.ts, NOT injecting context.lc's homepage website snapshot
 *    into tex.lc's `/`, which the app draws as the Tex landing instead.
 *
 * Every other path rule in `route.ts` applies on a Tex host unchanged.
 */

import type { PreviewMeta } from "./preview";

/** Tex's canonical origin. Every absolute URL a Tex preview emits is built from this. */
export const TEX_ORIGIN = "https://tex.lc";
export const TEX_APEX = "tex.lc";
export const TEX_WWW_HOST = "www.tex.lc";

/**
 * The hosts that serve Tex. `tex-staging.context.lc` is the staging Worker's
 * stand-in, so the flow can be checked end to end before tex.lc itself is
 * pointed at production. It is under `.context.lc`, which `isPlatformHost`
 * already accepts; tex.lc is listed there by name.
 */
const TEX_HOSTS: ReadonlySet<string> = new Set([TEX_APEX, "tex-staging.context.lc"]);

/** `hostname` as `URL` hands it over: already lower-cased by the parser. */
export function isTexHost(hostname: string): boolean {
  return TEX_HOSTS.has(hostname.toLowerCase());
}

/** The 1200x630 Tex card, bundled like `/og/card.png` (`og-tex-card.source.html`). */
export const TEX_CARD_PATH = "/og/tex-card.png";
const TEX_CARD_URL = `${TEX_ORIGIN}${TEX_CARD_PATH}`;

const TEX_TITLE = "Tex: a personal assistant you just text";
const TEX_DESCRIPTION =
  "Tex keeps track of what you tell it, looks things up, puts plans on your " +
  "calendar and reminds you. It asks before it sends anything. iMessage only, " +
  "invite only for now.";
const TEX_IMAGE_ALT = "Tex. A personal assistant you just text.";

/*
 * THE SAME RULE AS preview.ts, AND FOR THE SAME REASON.
 *
 * Every value below is a frozen constant. Nothing derived from the request —
 * not the path, not the query, not the host (tex-staging.context.lc gets the
 * very same bytes as tex.lc) — reaches a Tex preview, so the card a crawler
 * sees cannot say whether a name in the URL exists. `texPreviewFor` takes a
 * path only to pick one of three constants, never to build one.
 *
 * `siteName` is set so the card signs as Tex rather than Context.LC, and so
 * the body's one link goes to tex.lc rather than context.lc; `renderPreviewHtml`
 * then also leaves out context.lc's icon links, which is right for a page that
 * is not Context's. tex.lc still answers `/favicon.ico` itself.
 */

/** tex.lc's own landing. Public by intent and identical for every visitor. */
export const TEX_HOME_PREVIEW: PreviewMeta = Object.freeze({
  title: TEX_TITLE,
  description: TEX_DESCRIPTION,
  canonical: `${TEX_ORIGIN}/`,
  imageAlt: TEX_IMAGE_ALT,
  imageUrl: TEX_CARD_URL,
  siteName: "Tex",
  homeLabel: "Open tex.lc",
});

/**
 * `/waitlist` is a person's own place in line: the same words as the landing,
 * because a link to it is usually someone passing Tex along, but kept out of
 * search. The tag says so here; the `X-Robots-Tag` header index.ts adds says
 * it again for a crawler that has not parsed the body.
 */
export const TEX_WAITLIST_PREVIEW: PreviewMeta = Object.freeze({
  ...TEX_HOME_PREVIEW,
  canonical: `${TEX_ORIGIN}/waitlist`,
  robots: "noindex, nofollow",
});

/**
 * Every other tex.lc path a crawler asks about: GENERIC_PREVIEW's Tex twin.
 * Canonical at the root, so two links are identical rather than similar, and
 * noindex, so none of them is published by being linked.
 */
export const TEX_GENERIC_PREVIEW: PreviewMeta = Object.freeze({
  title: "Tex",
  description:
    "A personal assistant you just text. iMessage only, invite only for now. " +
    "Sign in to open this link.",
  canonical: `${TEX_ORIGIN}/`,
  imageAlt: TEX_IMAGE_ALT,
  imageUrl: TEX_CARD_URL,
  siteName: "Tex",
  homeLabel: "Open tex.lc",
  robots: "noindex, nofollow",
});

/**
 * The crawler card for a path on a Tex host that would otherwise get one of
 * preview.ts's static cards. Only the paths with their own dynamic logic
 * (share tokens, team links, short links, websites) are decided elsewhere,
 * exactly as on context.lc.
 *
 * Context's own marketing routes (`/login`'s "Sign in — Context") get the
 * Tex generic card here rather than Context copy with a context.lc canonical.
 */
export function texPreviewFor(pathname: string): PreviewMeta {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/") return TEX_HOME_PREVIEW;
  if (path === "/waitlist") return TEX_WAITLIST_PREVIEW;
  return TEX_GENERIC_PREVIEW;
}

/**
 * tex.lc's robots.txt: context.lc's "allow everything", less the two places a
 * search result would only ever be somebody's own page — their waitlist status
 * and their console. Sign-in is what actually protects the console; this is
 * so a crawler that follows a pasted link does not list it either.
 */
export const TEX_ROBOTS_TXT =
  "User-agent: *\nDisallow: /waitlist\nDisallow: /console\nAllow: /\n";
