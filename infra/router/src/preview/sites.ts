/**
 * Website pages: a link to a published page unfurls as that page.
 *
 * Everything else a crawler can reach on a name-bearing path gets the frozen
 * product card, so a guessable address cannot tell anyone whether a workspace
 * exists. A website page is the one thing at such an address its owner has
 * published to everybody: turning the site on is that decision, and anyone who
 * opens the link sees the page. So a crawler is told what a visitor would be,
 * and no more — the page's title, its site's name, one line of description, and
 * a card drawn from those two names. The control plane decides whether there
 * is such a page (`/site/preview`), resolving it exactly as it would for an
 * anonymous visitor; this file only shapes the answer, and every absence is
 * the product card byte for byte.
 */

import { GENERIC_PREVIEW, type PreviewMeta } from "./meta";
import { SHORT_LINK_SLUG } from "./shortLinks";

/** Where a page's card is served on a customer's domain. */
export const SITE_CARD_PATH = "/og/page.png";
/** …and on context.lc, where the address has to carry the handle. */
export const HANDLE_CARD_PREFIX = "/og/w/@";

const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION = /^[0-9a-f]{8}$/;
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 200;

export interface SitePreviewAnswer {
  title: string | null;
  description: string | null;
  siteName: string | null;
  cardVersion: string | null;
}

/** The control plane's answer, shape-checked. Anything malformed is absence. */
export function parseSitePreview(body: unknown): SitePreviewAnswer {
  const payload = (body ?? {}) as Record<string, unknown>;
  const text = (value: unknown, max: number): string | null => {
    if (typeof value !== "string") return null;
    const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
    return clean === "" ? null : clean.slice(0, max);
  };
  const version = payload.cardVersion;
  return {
    title: text(payload.title, MAX_TITLE),
    description: text(payload.description, MAX_DESCRIPTION),
    siteName: text(payload.siteName, MAX_TITLE),
    cardVersion: typeof version === "string" && VERSION.test(version) ? version : null,
  };
}

/**
 * A website route path, validated the way the site's own router validates one:
 * rooted, no empty, dot or dot-dot segment, no control characters, no
 * backslash, and nothing a second decode could reinterpret. `null` otherwise.
 */
export function siteRoutePath(path: string | null): string | null {
  if (path === null || path.length > 1024 || !path.startsWith("/")) return null;
  if (CONTROL_OR_BACKSLASH.test(path) || /[?#%]/.test(path)) return null;
  if (path === "/") return path;
  const trimmed = path.replace(/\/+$/, "");
  const segments = trimmed.slice(1).split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) {
    return null;
  }
  return trimmed.normalize("NFC");
}

/** The card's address. The path is percent-encoded, so it is one query value. */
export function siteCardUrl(
  origin: string,
  handle: string | null,
  routePath: string,
  version: string,
): string {
  const base = handle === null ? SITE_CARD_PATH : `${HANDLE_CARD_PREFIX}${handle}.png`;
  return `${origin}${base}?path=${encodeURIComponent(routePath)}&v=${version}`;
}

/**
 * The page a card address names: `{ handle, routePath, version }`, or `null`.
 * `handle` is `null` on a customer's domain, where the binding supplies it and
 * an address naming any other workspace would be refused.
 */
export function siteCardFrom(
  url: URL,
  onSite: boolean,
): { handle: string | null; routePath: string; version: string | null } | null {
  let handle: string | null = null;
  if (onSite) {
    if (url.pathname !== SITE_CARD_PATH) return null;
  } else {
    if (!url.pathname.startsWith(HANDLE_CARD_PREFIX) || !url.pathname.endsWith(".png")) {
      return null;
    }
    handle = url.pathname.slice(HANDLE_CARD_PREFIX.length, -".png".length);
    if (!HANDLE.test(handle)) return null;
  }
  const routePath = siteRoutePath(url.searchParams.get("path"));
  if (routePath === null) return null;
  const version = url.searchParams.get("v");
  return { handle, routePath, version: version !== null && VERSION.test(version) ? version : null };
}

/**
 * The tags for a page, or the product card when there is no page.
 *
 * `origin` is the address the crawler asked (`https://seyi.co`, or
 * `https://context.lc` with `/@handle` as `prefix`), never a header: the
 * hostname already resolved to this workspace, and the path is the validated
 * route path, so the canonical URL is built from checked parts only.
 */
export function previewForSitePage(
  answer: SitePreviewAnswer,
  place: { origin: string; prefix: string; handle: string | null; routePath: string },
): PreviewMeta {
  if (answer.title === null || answer.siteName === null) return GENERIC_PREVIEW;
  const path = place.routePath === "/" ? (place.prefix === "" ? "/" : "") : place.routePath;
  const canonical = `${place.origin}${place.prefix}${encodeURI(path)}`;
  // The page's own title; its site's name travels as `og:site_name`, which is
  // the line an unfurler draws beside it. On the home page the two are one.
  const same = answer.title.toLowerCase() === answer.siteName.toLowerCase();
  return {
    title: answer.title,
    description: answer.description ?? "",
    canonical,
    siteName: answer.siteName,
    homeLabel: `Open ${answer.siteName}`,
    imageAlt: same ? answer.siteName : `${answer.title}, ${answer.siteName}`,
    imageUrl:
      answer.cardVersion === null
        ? null
        : siteCardUrl(place.origin, place.handle, place.routePath, answer.cardVersion),
    robots: "noindex, nofollow",
  };
}

/**
 * `/@handle/<page path>` on context.lc: the address a site's pages are served
 * at before it has a domain of its own. `null` when the URL is not one.
 */
export function handleSiteFrom(
  url: URL,
): { handle: string; routePath: string; legacySlug: string | null } | null {
  if (url.pathname.length > 3072 || /%(?:2f|5c)/i.test(url.pathname)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const match = /^\/@([^/]+)(\/.*)?$/.exec(decoded);
  if (match === null) return null;
  const handle = match[1]!;
  if (!HANDLE.test(handle)) return null;
  // `/@seyi` alone stays the frozen product card, and asks nobody: a handle is
  // guessable and unbounded, which is the case that card exists for. A site's
  // home page unfurls as itself at the site's own domain.
  if (match[2] === undefined || match[2] === "/") return null;
  const routePath = siteRoutePath(match[2]);
  if (routePath === null) return null;
  const segment = routePath.slice(1);
  const legacySlug =
    segment !== "" && !segment.includes("/") && SHORT_LINK_SLUG.test(segment) ? segment : null;
  return { handle, routePath, legacySlug };
}
