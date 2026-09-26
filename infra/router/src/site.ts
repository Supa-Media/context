/**
 * Customer domains: what a request to `docs.acme.com` may reach.
 *
 * Pure, like `route.ts` beside it. A customer's domain serves one workspace's
 * published links and nothing else, so its routing table is short and closed:
 *
 *   /                -> the homepage link the owner chose (the SPA, or a
 *                       crawler's card)
 *   /<path>          -> a website page, with one-segment legacy short links
 *                       resolved by the app only when no page owns the path
 *   /_expo/...       -> the web bundle, identical for every host
 *   /icon.png, ...   -> the handful of static files the page itself loads
 *   /robots.txt      -> "Disallow: /", because nothing here is indexed
 *   everything else  -> 404, without asking anybody
 *
 * Deliberately not reachable: `/api/auth/*` (sign-in stays on context.lc, so
 * no session is ever minted for a customer's origin), `/@other/slug` (a domain
 * never serves another workspace's address), and every console route.
 *
 * Which workspace a host serves is never read from the request — no header,
 * no path, no query. `index.ts` asks the control plane with the hostname the
 * request actually arrived at, and an unknown, unverified or unpaid host gets
 * the same 404 as a path that does not exist.
 */

import { isCrawler, OG_CARD_PATH, type PreviewMeta } from "./preview";
import { SHORT_LINK_SLUG } from "./preview/shortLinks";
import { siteCardFrom } from "./preview/sites";

export interface SiteBinding {
  handle: string;
  homeSlug: string | null;
}

/**
 * Is this one of our own hostnames, served by the ordinary routing table?
 *
 * Everything under `context.lc`, a `workers.dev` preview, and local
 * development. Anything else that reaches this Worker arrived through the
 * Cloudflare for SaaS fallback, which only routes hostnames we registered.
 */
export function isPlatformHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "context.lc" ||
    host.endsWith(".context.lc") ||
    host.endsWith(".workers.dev") ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]"
  );
}

/** The static files `public/index.html` and the SPA load from the root. */
const STATIC_FILE =
  /^\/[a-z0-9][a-z0-9._-]*\.(?:js|png|ico|svg|webmanifest|json|css|woff2?|ttf|txt|map)$/i;
const RESERVED_FIRST_SEGMENTS = new Set([
  ".well-known",
  "_expo",
  "api",
  "assets",
  "auth",
  "console",
  "favicon.ico",
  "health",
  "icon.png",
  "og",
  "preview",
  "robots.txt",
  "s",
]);
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;

/** A decoded website path that cannot escape into the platform route table. */
function websitePath(pathname: string): string | null {
  // Encoded separators change segment ownership after decoding. A remaining
  // percent after one decode is a second possible interpretation, so neither
  // form is allowed to reach the SPA.
  if (pathname.length > 3072 || /%(?:2f|5c)/i.test(pathname)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (
    !decoded.startsWith("/") ||
    decoded.length > 1024 ||
    CONTROL_OR_BACKSLASH.test(decoded) ||
    /[?#%]/.test(decoded)
  ) {
    return null;
  }
  const withoutTrailing =
    decoded === "/" ? decoded : decoded.replace(/\/+$/, "");
  if (withoutTrailing === "/") return "/";
  const segments = withoutTrailing.slice(1).split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith("."),
    )
  ) {
    return null;
  }
  const first = segments[0]!.normalize("NFC").toLowerCase();
  if (first.startsWith("@") || RESERVED_FIRST_SEGMENTS.has(first)) return null;
  return withoutTrailing.normalize("NFC");
}

export type SiteDecision =
  | { kind: "site-missing" }
  | { kind: "site-robots" }
  | { kind: "og-card" }
  | { kind: "preview"; meta: PreviewMeta }
  | { kind: "short-link-preview"; handle: string; slug: string }
  | {
      kind: "site-preview";
      handle: string;
      routePath: string;
      legacySlug?: string;
      origin: string;
      prefix: string;
    }
  | { kind: "site-card"; handle: string; routePath: string; version: string | null }
  | { kind: "proxy"; upstream: "expo"; path: string; cache?: "immutable" };

/** Route a request that arrived at a customer's domain. */
export function siteRoute(
  url: URL,
  userAgent: string | null | undefined,
  binding: SiteBinding | null,
): SiteDecision {
  if (binding === null) return { kind: "site-missing" };
  const { pathname, search } = url;
  const path = `${pathname}${search}`;

  if (pathname === "/robots.txt") return { kind: "site-robots" };
  if (pathname === OG_CARD_PATH) return { kind: "og-card" };
  // A page's own card. Before the crawler check like the product card above:
  // the image the tags point at is fetched with the same User-Agent.
  const card = siteCardFrom(url, true);
  if (card !== null) {
    return { kind: "site-card", handle: binding.handle, routePath: card.routePath, version: card.version };
  }
  if (pathname.startsWith("/_expo/")) {
    return { kind: "proxy", upstream: "expo", path, cache: "immutable" };
  }
  if (STATIC_FILE.test(pathname))
    return { kind: "proxy", upstream: "expo", path };

  let slug: string | null;
  let routePath = "/";
  if (pathname === "/") {
    slug = binding.homeSlug;
  } else {
    const checked = websitePath(pathname);
    if (checked === null) return { kind: "site-missing" };
    routePath = checked;
    const segment = routePath.slice(1);
    slug =
      !segment.includes("/") && SHORT_LINK_SLUG.test(segment) ? segment : null;
  }

  // Every address is a website page first, as it is for a visitor; a legacy
  // short link at the same address is asked about only when no page owns it.
  if (isCrawler(userAgent)) {
    return {
      kind: "site-preview",
      handle: binding.handle,
      routePath,
      ...(slug === null ? {} : { legacySlug: slug }),
      origin: `https://${url.hostname.toLowerCase()}`,
      prefix: "",
    };
  }
  return { kind: "proxy", upstream: "expo", path };
}

/** What a request the site does not serve gets. Says nothing about why. */
export const SITE_MISSING_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Not found</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:15px/1.5 system-ui,-apple-system,sans-serif;background:#f6f5f1;color:#1c1b19}
@media (prefers-color-scheme:dark){body{background:#151412;color:#ecebe6}}main{text-align:center;padding:24px}h1{font-size:18px;font-weight:600;margin:0 0 6px}p{margin:0;opacity:.7}</style>
</head><body><main><h1>Nothing here</h1><p>This page doesn't exist, or is no longer shared.</p></main></body></html>
`;
