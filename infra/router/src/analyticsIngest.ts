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

/** Forward one analytics request, carrying only what the rules above allow. */
export async function ingestResponse(
  request: Request,
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!METHODS.has(request.method)) {
    return new Response(null, { status: 405, headers: { Allow: "GET, POST, OPTIONS", "Cache-Control": "no-store" } });
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
    return new Response(null, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  const answer = new Headers(upstream.headers);
  answer.delete("set-cookie");
  return new Response(upstream.body, { status: upstream.status, headers: answer });
}
