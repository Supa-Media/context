/**
 * Serving a customer's domain: find out which workspace it is, then route.
 *
 * The lookup is the control plane's `/domain/resolve`, asked with the hostname
 * this request arrived at and nothing else. Its answer is cached per colo for
 * a minute — a domain being connected or removed takes effect within that —
 * and a failure to ask is a 503 that is never cached, so a control plane
 * mid-deploy cannot make a live site look disconnected for longer than the
 * outage itself.
 */

import type { Env } from "./index";
import type { RouteDecision } from "./route";
import { SITE_MISSING_HTML, siteRoute, type SiteBinding } from "./site";
import { isSitePageRequest, sitePageResponse } from "./sitePages";

const RESOLVE_TIMEOUT_MS = 1_500;
const BINDING_CACHE_SECONDS = 60;

type Respond = (
  decision: RouteDecision,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response>;

/** Every response from a customer's domain says the same thing to a search engine. */
const NO_INDEX = "noindex, nofollow, noarchive, nosnippet";

function readOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function cacheOrNull(): Cache | null {
  try {
    return caches.default;
  } catch {
    return null;
  }
}

/**
 * The binding for a hostname: `SiteBinding`, `null` for "not a live site", or
 * `"unavailable"` when the control plane could not be asked.
 */
async function bindingFor(
  hostname: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<SiteBinding | null | "unavailable"> {
  const origin = readOrigin(env.CONVEX_ORIGIN);
  if (origin === null) return "unavailable";

  const cache = cacheOrNull();
  // Our own key, built from the validated hostname; the request's URL, query
  // and headers never reach it.
  const cacheKey = new Request(`https://context.lc/__site-binding/${encodeURIComponent(hostname)}`);
  try {
    const cached = await cache?.match(cacheKey);
    if (cached) return parseBinding(await cached.json());
  } catch {
    // A cache we cannot read is a slower request, not a failed one.
  }

  let body: unknown;
  try {
    const signal =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
        : undefined;
    const response = await fetch(`${origin}/domain/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return "unavailable";
    body = await response.json();
  } catch {
    return "unavailable";
  }

  const binding = parseBinding(body);
  if (cache !== null) {
    const stored = new Response(JSON.stringify(binding ?? { handle: null, homeSlug: null }), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${BINDING_CACHE_SECONDS}` },
    });
    ctx.waitUntil(cache.put(cacheKey, stored).catch(() => undefined));
  }
  return binding;
}

/** Shape-checked, so an upstream answer never becomes a path unchecked. */
function parseBinding(body: unknown): SiteBinding | null {
  const payload = body as { handle?: unknown; homeSlug?: unknown } | null;
  const handle = payload?.handle;
  if (typeof handle !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(handle)) return null;
  const home = payload?.homeSlug;
  const homeSlug =
    typeof home === "string" && /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(home) ? home : null;
  return { handle, homeSlug };
}

function plain(status: number, body: string, contentType: string, cacheControl = "no-store"): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      "X-Robots-Tag": NO_INDEX,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}

export async function siteResponse(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  respond: Respond,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain(405, "Method not allowed\n", "text/plain; charset=utf-8");
  }
  const binding = await bindingFor(url.hostname.toLowerCase(), env, ctx);
  if (binding === "unavailable") {
    return plain(503, "This site is temporarily unavailable. Try again in a moment.\n", "text/plain; charset=utf-8");
  }

  if (binding !== null && isSitePageRequest(url)) {
    return await sitePageResponse(request, url, readOrigin(env.CONVEX_ORIGIN), ctx, binding);
  }
  const decision = siteRoute(url, request.headers.get("User-Agent"), binding);
  if (decision.kind === "site-missing") {
    return plain(404, SITE_MISSING_HTML, "text/html; charset=utf-8");
  }
  if (decision.kind === "site-robots") {
    return plain(200, "User-agent: *\nDisallow: /\n", "text/plain; charset=utf-8", "public, max-age=3600");
  }

  const response = await respond(decision, request, env, ctx);
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", NO_INDEX);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
