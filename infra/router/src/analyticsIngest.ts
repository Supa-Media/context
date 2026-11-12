/**
 * `/ingest/*`: the app's product analytics, sent through our own address.
 *
 * The web app sends its PostHog events to `https://context.lc/ingest/...`
 * (`apps/mobile/features/observability/runtime.web.ts`) rather than to
 * PostHog's own host, because the blockers many of our visitors run drop
 * requests to that host by name, and the staff console's Usage tab would then
 * count a fraction of the visits. The events are the same ones, already
 * cleaned in the browser; this only changes the road they take.
 *
 * What the road may carry is the point of this file:
 *
 *  - **Only the headers PostHog needs**, copied from an allowlist. Above all
 *    never `Cookie` — the same origin now means our session cookie arrives
 *    with every event — and never `Authorization`.
 *  - **Not the visitor's address.** No `X-Forwarded-For`, no
 *    `CF-Connecting-IP`: PostHog sees this Worker, not the person, which is
 *    more than the direct road ever gave.
 *  - **Nothing set back on our origin.** `Set-Cookie` from PostHog is dropped,
 *    so its answer cannot write a cookie that `context.lc` would then send to
 *    our own routes.
 *  - **Two fixed upstreams**, chosen by path. The request never names a host.
 *  - **Our own origin only, for cross-origin reads.** PostHog answers every
 *    origin (`Access-Control-Allow-Origin` reflected or `*`), and passing that
 *    through let any site read these responses, the SDK's scripts included,
 *    with no `Vary: Origin` to keep a cache from serving one origin's answer
 *    to another (CASA 6.3.1, 2026-11-11). The SDK runs on the page that sent
 *    it, so the only origin that ever needs an answer is the one the request
 *    came to: `context.lc` on `context.lc`, `tex.lc` on `tex.lc`, staging on
 *    staging. PostHog's CORS headers are dropped and ours set from that
 *    allowlist of one, every answer carries `Vary: Origin`, and a preflight
 *    is answered here rather than forwarded.
 */

export const INGEST_PREFIX = "/ingest";

/** PostHog US Cloud: events, and the SDK's own scripts. */
const POSTHOG_ORIGIN = "https://us.i.posthog.com";
const POSTHOG_ASSETS_ORIGIN = "https://us-assets.i.posthog.com";

const FORWARDED_HEADERS = ["accept", "accept-encoding", "content-encoding", "content-type", "user-agent"] as const;
const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "OPTIONS"]);

/**
 * The PostHog URL an `/ingest` path stands for, or `null` for any other path.
 *
 * `/ingest/static/*` and `/ingest/array/*` are the SDK's lazily loaded code
 * and remote configuration, which PostHog serves from its assets host (its
 * own guide to proxying says the same); everything else is the API.
 */
export function ingestTarget(url: URL): string | null {
  const { pathname, search } = url;
  if (pathname !== INGEST_PREFIX && !pathname.startsWith(`${INGEST_PREFIX}/`)) return null;
  const rest = pathname.slice(INGEST_PREFIX.length) || "/";
  const origin = rest.startsWith("/static/") || rest.startsWith("/array/") ? POSTHOG_ASSETS_ORIGIN : POSTHOG_ORIGIN;
  return `${origin}${rest}${search}`;
}

/**
 * The CORS headers this answer may carry: `Access-Control-Allow-Origin` only
 * for the origin the request was sent to, and `Vary: Origin` always.
 */
function corsHeaders(request: Request, headers: Headers): Headers {
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("access-control-")) headers.delete(name);
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin === new URL(request.url).origin) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  const vary = headers.get("vary");
  if (vary === null || vary.trim() === "") headers.set("Vary", "Origin");
  else if (!vary.split(",").some((part) => part.trim().toLowerCase() === "origin" || part.trim() === "*")) {
    headers.set("Vary", `${vary}, Origin`);
  }
  return headers;
}

/** Forward one analytics request, carrying only what the rules above allow. */
export async function ingestResponse(
  request: Request,
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!METHODS.has(request.method)) {
    return new Response(null, { status: 405, headers: corsHeaders(request, new Headers({ Allow: "GET, POST, OPTIONS", "Cache-Control": "no-store" })) });
  }
  if (request.method === "OPTIONS") {
    // A same-origin page never sends one; anyone else learns nothing here.
    const headers = corsHeaders(request, new Headers({ "Cache-Control": "no-store" }));
    if (headers.has("Access-Control-Allow-Origin")) {
      headers.set("Access-Control-Allow-Methods", "GET, POST");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Content-Encoding");
    }
    return new Response(null, { status: 204, headers });
  }
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const hasBody = request.method === "POST";
  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    // Analytics never breaks a page: the SDK retries a failed send on its own.
    return new Response(null, { status: 502, headers: corsHeaders(request, new Headers({ "Cache-Control": "no-store" })) });
  }
  const answer = corsHeaders(request, new Headers(upstream.headers));
  answer.delete("set-cookie");
  return new Response(upstream.body, { status: upstream.status, headers: answer });
}
