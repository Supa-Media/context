/**
 * context-router — the Cloudflare Worker that makes https://context.lc the
 * public address of the Expo web app, and hands the auth flow's HTTP routes to
 * Convex.
 *
 * All the routing *decisions* live in ./route.ts as a pure, config-free
 * function so they can be unit-tested without the Workers runtime. This module
 * resolves an upstream to a real origin, validates that configuration, and
 * turns a decision into an actual Response.
 */
import { previewForShare, renderPreviewHtml } from "./preview";
import { renderShareCard } from "./ogCard";
import { route, type Upstream } from "./route";
// Bundled as bytes by the `Data` rule in wrangler.jsonc, so the OpenGraph card
// ships with the Worker. Deliberately not an Expo bundle asset: the one thing
// a crawler is guaranteed to fetch should not depend on an upstream that might
// be mid-deploy. See og-card.source.html for how the image is produced.
import ogCard from "./og-card.png";

interface Env {
  /** EAS Hosting origin for the exported Expo web bundle. */
  EXPO_ORIGIN?: string;
  /** Convex HTTP-actions origin, i.e. `https://<deployment>.convex.site`. */
  CONVEX_ORIGIN?: string;
}

/**
 * Accept a var only if it is a bare https origin — no path, query, or fragment.
 *
 * Validated on every request rather than assumed, because both origins arrive
 * as Worker vars and a half-finished config would otherwise become a proxy to
 * somewhere unintended. Failing closed with a 503 that names the variable is
 * the honest outcome: the reason is in the response, instead of the site being
 * up and quietly serving someone else's origin.
 */
function readOrigin(value: string | undefined): string | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
  return parsed.origin;
}

/**
 * Resolved per upstream, not up front, so a missing CONVEX_ORIGIN takes down
 * only the auth routes rather than the whole site.
 */
function originFor(upstream: Upstream, env: Env): string | null {
  return upstream === "convex"
    ? readOrigin(env.CONVEX_ORIGIN)
    : readOrigin(env.EXPO_ORIGIN);
}

const VAR_NAME: Record<Upstream, string> = {
  expo: "EXPO_ORIGIN",
  convex: "CONVEX_ORIGIN",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const decision = route(
      new URL(request.url),
      request.headers.get("User-Agent"),
    );

    switch (decision.kind) {
      case "preview":
        return new Response(renderPreviewHtml(decision.meta), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            // This response depends on the User-Agent, and the body is a
            // constant string that costs nothing to regenerate. Letting a
            // shared cache keep it would risk handing the crawler shell to a
            // person on the same URL, so: don't store it, and say so twice for
            // caches that honour only one of the two.
            "Cache-Control": "no-store",
            Vary: "User-Agent",
            // Belt and braces against a preview being framed or sniffed into
            // something else. It is inert HTML with no script of its own.
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          },
        });

      case "share-preview": {
        // A share link's card may carry the note's title — the one deliberate
        // exception to the frozen-card rule, argued in preview.ts. Everything
        // about this branch is built so that failing produces the frozen card
        // rather than an error or a partial one.
        const meta = previewForShare(
          await shareTitle(decision.token, readOrigin(env.CONVEX_ORIGIN)),
          decision.token,
        );
        return new Response(renderPreviewHtml(meta), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            Vary: "User-Agent",
            // A share's card must never be indexed, whatever the tags say.
            // The header is what a crawler obeys when it has not parsed the
            // body yet, and it is the half that survives a template change.
            "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          },
        });
      }

      case "share-card":
        return await shareCardResponse(decision.token, env, ctx);

      case "og-card":
        return new Response(ogCard, {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            // A day, not a year: the path is not content-hashed, so a longer
            // TTL would need a purge to correct a bad card.
            "Cache-Control": "public, max-age=86400",
            "X-Content-Type-Options": "nosniff",
          },
        });

      case "redirect":
        // Deterministic (host-only) redirects are safe to cache. A plain
        // `Response.redirect()` isn't cacheable at the edge, so build the
        // response by hand with an explicit Cache-Control.
        return new Response(null, {
          status: 301,
          headers: {
            Location: decision.location,
            "Cache-Control": "public, max-age=86400",
          },
        });

      case "proxy": {
        const origin = originFor(decision.upstream, env);
        if (!origin) {
          return new Response(
            `context-router is misconfigured: ${VAR_NAME[decision.upstream]} ` +
              `is not set to a bare https origin.\n`,
            { status: 503, headers: { "Cache-Control": "no-store" } },
          );
        }

        const target = new URL(`${origin}${decision.path}`);
        // Passing the original `request` as the second argument copies its
        // method, headers, and body onto the new URL — the standard Workers
        // proxy idiom. The response is returned without ever being read, so
        // the body streams straight through and SSE / chunked responses keep
        // working.
        // https://developers.cloudflare.com/workers/examples/respond-with-another-site/
        const proxyRequest = new Request(target, request);
        proxyRequest.headers.set("Host", target.host);

        if (decision.cache === "immutable") {
          // Cookie-bearing requests are ineligible for edge caching, so strip
          // the cookie before handing off. Safe here and only here: this
          // branch is content-hashed static bundle output, identical for every
          // visitor and never varying by session.
          proxyRequest.headers.delete("Cookie");
          return fetch(proxyRequest, {
            cf: { cacheEverything: true, cacheTtl: 31536000 },
          });
        }

        return fetch(proxyRequest);
      }
    }
  },
};

/**
 * How long the control plane gets to answer before the card falls back.
 *
 * An unfurler waits a second or two and then shows nothing, so a slow lookup is
 * not worth having: a frozen card beats no card, and no card is what a timeout
 * upstream of us produces.
 */
const SHARE_TITLE_TIMEOUT_MS = 1_500;

/**
 * The title for a share token, or `null`.
 *
 * `null` on every failure, and the list of failures is deliberately everything:
 * no CONVEX_ORIGIN, a non-200, a body that is not JSON, a `title` that is not a
 * string, a timeout, a thrown fetch. `previewForShare(null)` is GENERIC_PREVIEW
 * byte for byte, so all of them land on the frozen card — which is the same
 * answer a revoked share gets, and that is what keeps revocation invisible to
 * a crawler.
 *
 * The obligation `preview.ts` wrote down for whoever wired an upstream in here
 * was "a negative response byte-identical to a positive one's absence". This is
 * that: there is one `null` and one card, and no branch that reports *why*.
 *
 * POST, because a GET would put the share token in this Worker's outbound URL
 * and from there into logs — the control plane's routes are POST for the same
 * reason.
 */
async function shareTitle(
  token: string,
  convexOrigin: string | null,
): Promise<string | null> {
  if (!convexOrigin) return null;

  const timeout =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(SHARE_TITLE_TIMEOUT_MS)
      : undefined;

  try {
    const response = await fetch(`${convexOrigin}/share/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      ...(timeout ? { signal: timeout } : {}),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const title = (body as { title?: unknown } | null)?.title;
    return typeof title === "string" && title.trim() !== "" ? title : null;
  } catch {
    return null;
  }
}

/**
 * How long a rendered card sits in the edge cache.
 *
 * An hour, not a year, and the short TTL is not the invalidation strategy — the
 * title hash in the URL is (see `shareCardPath`). The Workers Cache API is
 * per-datacenter and `cache.delete` purges only the colo the Worker ran in, so
 * there is no global purge to reach for. An hour just bounds how long a colo
 * keeps serving a card whose share was revoked a moment ago; the URL changing
 * is what makes an *edited* title take effect at once.
 */
const CARD_CACHE_SECONDS = 3600;

/**
 * The card image for one share.
 *
 * Every failure lands on the static product card with a 200. That is the whole
 * design: a crawler that receives a 5xx shows **no card at all**, which is a
 * worse outcome than a generic one, and it is the outcome an unhandled throw
 * would produce. So the rules are:
 *
 *  - No title (revoked, expired, title switched off, control plane unreachable)
 *    → static card. Identical to what `previewForShare(null)` does for the
 *    tags, which is what keeps revocation invisible.
 *  - A title with a glyph our fonts cannot draw → static card, because satori
 *    would silently render tofu rather than fail.
 *  - Anything thrown → static card.
 *
 * **The `?v=` parameter is never read.** The title is re-resolved from the
 * token on every render. An endpoint that drew the text it was handed would
 * make context.lc an arbitrary-text image generator carrying our own branding,
 * which is a phishing asset rather than a feature.
 */
async function shareCardResponse(
  token: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const cache = caches.default;
  // Keyed on the full URL, so the `?v=` hash separates one title's card from
  // the next without either of them needing to be purged.
  const cacheKey = new Request(`https://context.lc/og/s/${token}.png`);

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const response = await renderedCard(token, env);
  if (response.ok) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function renderedCard(token: string, env: Env): Promise<Response> {
  try {
    const title = await shareTitle(token, readOrigin(env.CONVEX_ORIGIN));
    if (title !== null) {
      const rendered = await renderShareCard(title);
      // `null` means a glyph we cannot draw — an expected answer, not a fault.
      if (rendered !== null) return withCardHeaders(rendered);
    }
  } catch {
    // Fall through. A crawler cannot act on an error and a 5xx shows no card.
  }
  return staticCard();
}

function staticCard(): Response {
  return withCardHeaders(new Response(ogCard));
}

function withCardHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "image/png");
  headers.set("Cache-Control", `public, max-age=${CARD_CACHE_SECONDS}`);
  // The same refusal the share preview HTML carries. A card with a title on it
  // is still not search-engine material.
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: 200, headers });
}
