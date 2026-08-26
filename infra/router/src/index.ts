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
import { renderPreviewHtml } from "./preview";
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
  async fetch(request: Request, env: Env): Promise<Response> {
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
