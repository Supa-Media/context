/**
 * `/_site/page`: a website's page as an anonymous visitor sees it, kept at the
 * edge for as long as the site's revision holds still.
 *
 * Edits under `website/` wait for Publish (`docs/decisions/websites.md`), so
 * between two Publishes a page's answer changes only when a restriction lands,
 * and that moves the revision too. Each visit asks Convex's `/site/revision`
 * (one database read) and serves the copy kept under it; only a miss asks
 * `/site/page`, which is the one request that reads the customer's bucket. So
 * a page is read once per Publish per colo, not once per visit.
 *
 * A copy is also dropped after `PAGE_CACHE_SECONDS`, whatever the revision
 * says. That bounds the one case a revision cannot see coming: a restriction
 * written straight to the bucket, outside Context, before the next sweep
 * notices it. Convex says which answers may be kept at all (never
 * "unavailable", which is also what a bucket outage looks like).
 *
 * Signed-in visitors never come here: a members-only page is not the same
 * page for everybody, so the app asks Convex directly for them. This copy is
 * handed to anyone, so it is only ever what anyone may see; Convex answers
 * `/site/page` as nobody, whatever arrives with the request, and nothing from
 * the browser but the address reaches it.
 *
 * On a customer's domain the handle is the domain's binding and never read
 * from the request, exactly as for every other path there (`site.ts`).
 */

import type { SiteBinding } from "./site";

export const SITE_PAGE_PATH = "/_site/page";

const REVISION_TIMEOUT_MS = 1_500;
const PAGE_TIMEOUT_MS = 10_000;
/** See above: the bound on a restriction nobody told Context about. */
const PAGE_CACHE_SECONDS = 300;
const MAX_ANSWER = 2_000_000;

const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const CONTROL = /[\u0000-\u001f\u007f\\]/;
const KINDS = new Set(["page", "authentication_required", "unavailable", "legacy_short_link"]);

export interface SitePageAsk {
  handle: string;
  routePath: string;
  legacySlug: string | null;
}

export function isSitePageRequest(url: URL): boolean {
  return url.pathname === SITE_PAGE_PATH;
}

/**
 * The address asked for, or `null`. On a platform host the handle is a query
 * parameter; on a customer's domain it is the binding's, and the only legacy
 * slug is the one the owner chose for `/`.
 */
export function sitePageAsk(url: URL, bound: SiteBinding | null): SitePageAsk | null {
  const routePath = url.searchParams.get("path");
  if (routePath === null || !routePath.startsWith("/") || routePath.length > 1024 || CONTROL.test(routePath)) {
    return null;
  }
  if (bound !== null) {
    return { handle: bound.handle, routePath, legacySlug: routePath === "/" ? bound.homeSlug : null };
  }
  const handle = url.searchParams.get("handle");
  if (handle === null || !HANDLE.test(handle)) return null;
  const legacy = url.searchParams.get("legacy");
  if (legacy !== null && !SLUG.test(legacy)) return null;
  return { handle, routePath, legacySlug: legacy };
}

function cacheOrNull(): Cache | null {
  try {
    return caches.default;
  } catch {
    return null;
  }
}

async function postJson(url: string, body: unknown, limitMs: number): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(limitMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

/** Our own key, built from checked parts; the request's URL never reaches it. */
export function pageKey(ask: SitePageAsk, revision: string): Request {
  const legacy = ask.legacySlug === null ? "" : `?legacy=${ask.legacySlug}`;
  return new Request(
    `https://site-page.invalid/${ask.handle}/${encodeURIComponent(revision)}/${encodeURIComponent(ask.routePath)}${legacy}`,
  );
}

/** Convex's answer, or `null` when it is not one. The address is passed on as it came. */
export function parseSitePage(
  value: unknown,
): { revision: string | null; cacheable: boolean; address: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const revision = body.revision;
  if (revision !== null && (typeof revision !== "string" || revision.length > 200)) return null;
  const address = body.address as Record<string, unknown> | null;
  if (typeof address !== "object" || address === null || !KINDS.has(address.kind as string)) return null;
  const text = JSON.stringify(address);
  if (text.length > MAX_ANSWER) return null;
  return { revision, cacheable: body.cacheable === true && revision !== null, address: text };
}

function answer(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // The app asks again when the revision moves; a browser's own copy
      // would outlive a restriction.
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * The page's answer as JSON, from the kept copy when there is one. Any
 * failure is a 503 with nothing in it, and the app asks Convex itself.
 */
export async function sitePageResponse(
  request: Request,
  url: URL,
  convexOrigin: string | null,
  ctx: ExecutionContext,
  bound: SiteBinding | null = null,
): Promise<Response> {
  if (request.method !== "GET") return answer(405, "{}");
  const ask = sitePageAsk(url, bound);
  if (ask === null) return answer(400, "{}");
  if (convexOrigin === null) return answer(503, "{}");
  const cache = cacheOrNull();
  try {
    const asked = await postJson(`${convexOrigin}/site/revision`, { handle: ask.handle }, REVISION_TIMEOUT_MS);
    const revision = (asked as { revision?: unknown } | null)?.revision;
    if (typeof revision === "string" && revision.length <= 200) {
      const hit = await cache?.match(pageKey(ask, revision)).catch(() => undefined);
      if (hit) return answer(200, await hit.text());
    }
    const page = parseSitePage(
      await postJson(
        `${convexOrigin}/site/page`,
        {
          handle: ask.handle,
          routePath: ask.routePath,
          ...(ask.legacySlug === null ? {} : { legacySlug: ask.legacySlug }),
        },
        PAGE_TIMEOUT_MS,
      ),
    );
    if (page === null) return answer(503, "{}");
    if (cache !== null && page.cacheable && page.revision !== null) {
      const stored = new Response(page.address, {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${PAGE_CACHE_SECONDS}` },
      });
      ctx.waitUntil(cache.put(pageKey(ask, page.revision), stored).catch(() => undefined));
    }
    return answer(200, page.address);
  } catch {
    return answer(503, "{}");
  }
}
