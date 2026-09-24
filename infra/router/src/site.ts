/**
 * Customer domains: what a request to `docs.acme.com` may reach.
 *
 * Pure, like `route.ts` beside it. A customer's domain serves one workspace's
 * published links and nothing else, so its routing table is short and closed:
 *
 *   /                -> the homepage link the owner chose (the SPA, or a
 *                       crawler's card)
 *   /<short>         -> that workspace's short link, as /@handle/<short>
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
import { GENERIC_PREVIEW } from "./preview/meta";

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
const STATIC_FILE = /^\/[a-z0-9][a-z0-9._-]*\.(?:js|png|ico|svg|webmanifest|json|css|woff2?|ttf|txt|map)$/i;

export type SiteDecision =
  | { kind: "site-missing" }
  | { kind: "site-robots" }
  | { kind: "og-card" }
  | { kind: "preview"; meta: PreviewMeta }
  | { kind: "short-link-preview"; handle: string; slug: string }
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
  if (pathname.startsWith("/_expo/")) {
    return { kind: "proxy", upstream: "expo", path, cache: "immutable" };
  }
  if (STATIC_FILE.test(pathname)) return { kind: "proxy", upstream: "expo", path };

  let slug: string | null;
  if (pathname === "/") {
    slug = binding.homeSlug;
  } else {
    const segment = pathname.slice(1);
    if (!SHORT_LINK_SLUG.test(segment)) return { kind: "site-missing" };
    slug = segment;
  }

  if (isCrawler(userAgent)) {
    return slug === null
      ? { kind: "preview", meta: GENERIC_PREVIEW }
      : { kind: "short-link-preview", handle: binding.handle, slug };
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
