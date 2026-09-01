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
import { previewForNote, previewForShare, renderPreviewHtml } from "./preview";
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
        const [title, openToAnyone] = await shareTitle(
          decision.token,
          readOrigin(env.CONVEX_ORIGIN),
        );
        const meta = previewForShare(title, decision.token, openToAnyone);
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
        return await shareCardResponse(request.url, decision.token, env, ctx);

      case "note-preview": {
        const meta = previewForNote(
          ...(await noteTitle(decision.slug, decision.path, readOrigin(env.CONVEX_ORIGIN))),
        );
        return new Response(renderPreviewHtml(meta), {
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
): Promise<[string | null, boolean]> {
  // Every failure below answers the same pair, and it has to be the *pair*
  // rather than the title alone: an absence that came back "sign-in required"
  // and a live open link that came back "no sign-in" would be two answers where
  // this route has always had one. `previewForShare(null, …)` renders
  // GENERIC_PREVIEW whatever the second value is, so the pair is belt and
  // braces rather than the only guard — which is how two copies of a rule are
  // held here.
  if (!convexOrigin) return [null, false];

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
    if (!response.ok) return [null, false];
    const body: unknown = await response.json();
    const payload = body as { title?: unknown; openToAnyone?: unknown } | null;
    const title = payload?.title;
    if (typeof title !== "string" || title.trim() === "") return [null, false];
    // Strictly `=== true`, so an upstream that is older than this deployment —
    // or newer, or compromised — sends the reader to sign in rather than
    // telling them they need no account. The direction an unknown falls is
    // the same one the whole file falls in: towards saying less.
    return [title, payload?.openToAnyone === true];
  } catch {
    return [null, false];
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
 * How long the control plane gets to hand back a card.
 *
 * Longer than the 1.5s the title fetch allows, because this reads a *bucket* —
 * a round trip to somebody's R2 or S3 rather than a row lookup. Still short:
 * an unfurler waits a couple of seconds and then shows nothing, so a slow card
 * is worth abandoning for the static one.
 *
 * The card is **pre-rendered**, so this is never waiting on a render. If it
 * ever is, the design has drifted.
 */
const CARD_FETCH_TIMEOUT_MS = 3_000;

/**
 * The longest title this edge will draw, matching `MAX_PREVIEW_TITLE` in the
 * control plane. A second copy on purpose — see where it is used.
 */
const MAX_CARD_TITLE = 60;

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
  url: string,
  token: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const cache = cacheOrNull();
  // **Rebuilt from the token and a validated `v`, never from the URL as sent.**
  //
  // It used to be synthesised from the token alone, which made the `?v=` hash
  // `preview.ts` computes buy nothing: every version of a title collapsed into
  // one entry, so an owner retitling a share got the old card for the whole
  // TTL. The Workers Cache API is per-datacenter and `cache.delete` purges only
  // the colo the Worker ran in, so a changed title being a different key is the
  // only invalidation there is.
  //
  // Keying on `request.url` directly would fix that and hand the key to the
  // caller. This is an unauthenticated path: `?v=x&x=1`, a reordered query, a
  // different case, a four-thousand-character value and a fragment are six
  // distinct entries for one card, each miss an upstream POST and — for anyone
  // holding a real token — a fresh wasm render. Reconstructing the key keeps
  // the canonical shape the old code had *and* the invalidation it lacked.
  //
  // A malformed `v` is dropped rather than refused, because it is a cache hint
  // and not a request: an unfurler that mangles the query should still get a
  // card. And the query stays a **key**, never an input — the title is
  // re-resolved from the token on every render, so nothing here reaches what
  // is drawn.
  const version = new URL(url).searchParams.get("v");
  const suffix = version !== null && /^[0-9a-f]{8}$/.test(version) ? `?v=${version}` : "";
  const cacheKey = new Request(`https://context.lc/og/s/${token}.png${suffix}`);

  // The cache is best-effort, and saying so in the doc above was not enough:
  // `caches.default` and `cache.match` sat outside every `try`, so a colo whose
  // cache was unavailable produced the 5xx — a crawler showing **no card at
  // all** — that this whole function exists to avoid. A `put` that rejects was
  // already contained, because the response has been returned by then.
  try {
    // `?.` here is the type talking, not a guard: with `cache` null the `try`
    // below catches just as it does a colo fault, so replacing it with `!`
    // changes no behaviour and fails no test. The `try` is what makes both
    // safe. Said in place rather than left to look load-bearing.
    const cached = await cache?.match(cacheKey);
    if (cached) return cached;
  } catch {
    // Fall through and render. A cache we cannot read is a slow request, not a
    // failed one.
  }

  const response = await renderedCard(token, env);
  if (response.ok && cache !== null) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/**
 * The colo's cache, or nothing.
 *
 * `caches` is a global the runtime supplies and a test environment does not, so
 * reading `caches.default` unguarded threw a `ReferenceError` out of `fetch`
 * before any of this handler ran — which is both a 5xx in a runtime that lacks
 * it and the mechanical reason this handler had no end-to-end test until now.
 */
function cacheOrNull(): Cache | null {
  try {
    return caches.default;
  } catch {
    return null;
  }
}

async function renderedCard(token: string, env: Env): Promise<Response> {
  const origin = readOrigin(env.CONVEX_ORIGIN);
  if (origin === null) return staticCard();

  try {
    const timeout =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(CARD_FETCH_TIMEOUT_MS)
        : undefined;

    const response = await fetch(`${origin}/share/card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      ...(timeout ? { signal: timeout } : {}),
    });

    // 404 is every absence: unknown token, revoked, expired, title off, never
    // rendered, bucket unreachable. All of them mean the static product card,
    // which is what keeps revocation invisible to a crawler.
    if (!response.ok) return staticCard();

    const bytes = await response.arrayBuffer();
    // A zero-length body is not a card. Guarded because an empty 200 would
    // otherwise be cached and served as a broken image forever.
    if (bytes.byteLength === 0) return staticCard();

    return withCardHeaders(new Response(bytes));
  } catch {
    // A timeout, a dead socket, a control plane mid-deploy. A crawler that gets
    // an error shows no card at all, which is worse than a generic one.
    return staticCard();
  }
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

/**
 * The title, card and folder contents for a readable team link, or nothing.
 *
 * `[null, null, []]` on every failure — no CONVEX_ORIGIN, a non-200, a body
 * that is not JSON, a timeout, a thrown fetch — and `previewForNote(null)`
 * renders GENERIC_PREVIEW byte for byte. So an unlinked note, a revoked link
 * and a control plane mid-deploy are one answer, which is what keeps the probe
 * to "which notes has the owner published a card for".
 *
 * The third element is **only ever a decoration on a card that already has a
 * title.** It is passed through untouched here and bounded inside
 * `previewForNote`, which is also where a falsy title short-circuits to the
 * frozen card — so a control plane that answered with children and no title
 * publishes nothing at all.
 *
 * POST, like every route it talks to: a GET would put a handle and a note path
 * in this Worker's outbound URL and from there into logs.
 */
async function noteTitle(
  slug: string,
  path: string,
  convexOrigin: string | null,
): Promise<[string | null, string | null, unknown[]]> {
  if (!convexOrigin) return [null, null, []];

  const timeout =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(SHARE_TITLE_TIMEOUT_MS)
      : undefined;

  try {
    const response = await fetch(`${convexOrigin}/share/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, path }),
      ...(timeout ? { signal: timeout } : {}),
    });
    if (!response.ok) return [null, null, []];
    const body: unknown = await response.json();
    const title = (body as { title?: unknown } | null)?.title;
    const cardToken = (body as { cardToken?: unknown } | null)?.cardToken;
    const children = (body as { children?: unknown } | null)?.children;
    return [
      typeof title === "string" && title.trim() !== "" ? title : null,
      typeof cardToken === "string" && /^[0-9a-f]{64}$/.test(cardToken) ? cardToken : null,
      Array.isArray(children) ? children : [],
    ];
  } catch {
    return [null, null, []];
  }
}
