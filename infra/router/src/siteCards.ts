/**
 * Answering a crawler for a website page: the tags, and the card they point at.
 *
 * The decisions are made in `route.ts` and `site.ts`; the shaping in
 * `preview/sites.ts`. This module does the two round trips to the control
 * plane and holds the same failure rule every preview here holds: anything
 * that goes wrong is the product card for the tags, and for the picture a 404
 * (a page with no picture is better than a page wearing Context's).
 */

import { GENERIC_PREVIEW, renderPreviewHtml } from "./preview";
import { parseSitePreview, previewForSitePage, type SitePreviewAnswer } from "./preview/sites";

const PREVIEW_TIMEOUT_MS = 2_500;
/** A render is a page read and a satori pass; leave it room on a cold start. */
const CARD_TIMEOUT_MS = 8_000;
const CARD_CACHE_SECONDS = 3600;

export interface SitePreviewDecision {
  handle: string;
  routePath: string;
  legacySlug?: string;
  origin: string;
  prefix: string;
}

function timeout(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

function cacheOrNull(): Cache | null {
  try {
    return caches.default;
  } catch {
    return null;
  }
}

async function askSitePreview(
  convexOrigin: string,
  handle: string,
  routePath: string,
): Promise<SitePreviewAnswer | null> {
  try {
    const signal = timeout(PREVIEW_TIMEOUT_MS);
    const response = await fetch(`${convexOrigin}/site/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle, routePath }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return null;
    const answer = parseSitePreview(await response.json());
    return answer.title === null || answer.siteName === null ? null : answer;
  } catch {
    return null;
  }
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      Vary: "User-Agent",
      "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/**
 * The tags for a website address. When no page owns it and the address is a
 * legacy short link, `legacy` answers instead, exactly as the app falls back.
 */
export async function sitePreviewResponse(
  decision: SitePreviewDecision,
  convexOrigin: string | null,
  ctx: ExecutionContext,
  legacy: (slug: string) => Promise<Response>,
): Promise<Response> {
  const answer =
    convexOrigin === null ? null : await askSitePreview(convexOrigin, decision.handle, decision.routePath);
  if (answer === null) {
    return decision.legacySlug === undefined
      ? htmlResponse(renderPreviewHtml(GENERIC_PREVIEW))
      : await legacy(decision.legacySlug);
  }
  const handleInCard = decision.prefix === "" ? null : decision.handle;
  const meta = previewForSitePage(answer, {
    origin: decision.origin,
    prefix: decision.prefix,
    handle: handleInCard,
    routePath: decision.routePath,
  });
  // Draw the card while the crawler reads the tags, so the picture it asks
  // for next is usually already in this colo's cache.
  if (convexOrigin !== null && answer.cardVersion !== null) {
    ctx.waitUntil(
      siteCardResponse(
        { handle: decision.handle, routePath: decision.routePath, version: answer.cardVersion },
        convexOrigin,
        ctx,
      ).then(() => undefined, () => undefined),
    );
  }
  return htmlResponse(renderPreviewHtml(meta));
}

/**
 * A page's card. The cache key is rebuilt from the handle, the validated path
 * and a validated version, never taken from the URL as sent; the picture is
 * re-resolved from the page upstream, so nothing in the query is drawn, and
 * upstream draws it only when the version is the page's current one.
 */
export async function siteCardResponse(
  card: { handle: string; routePath: string; version: string | null },
  convexOrigin: string | null,
  ctx: ExecutionContext,
): Promise<Response> {
  const cache = cacheOrNull();
  const cacheKey = new Request(
    `https://context.lc/__site-card/@${card.handle}?path=${encodeURIComponent(card.routePath)}&v=${card.version ?? ""}`,
  );
  try {
    const cached = await cache?.match(cacheKey);
    if (cached) return cached;
  } catch {
    // A cache we cannot read is a slower request, not a failed one.
  }
  if (convexOrigin === null || card.version === null) return missingCard();
  let bytes: ArrayBuffer;
  try {
    const signal = timeout(CARD_TIMEOUT_MS);
    const response = await fetch(`${convexOrigin}/site/card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: card.handle, routePath: card.routePath, version: card.version }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return missingCard();
    bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0) return missingCard();
  } catch {
    return missingCard();
  }
  const response = new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": `public, max-age=${CARD_CACHE_SECONDS}`,
      "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
      "X-Content-Type-Options": "nosniff",
    },
  });
  if (cache !== null) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
  }
  return response;
}

/** Never cached: the next crawl should get a chance to draw it. */
function missingCard(): Response {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet" },
  });
}
