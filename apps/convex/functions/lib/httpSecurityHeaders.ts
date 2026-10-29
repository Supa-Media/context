/**
 * Two response headers every control-plane HTTP answer we own carries
 * (CASA ZAP, 2026-10-29: "Strict-Transport-Security header not set" and
 * "X-Content-Type-Options header missing" on the auth discovery documents and
 * the gateway routes). The deployment answers only over HTTPS, so HSTS tells a
 * browser never to try it in the clear; `nosniff` stops a browser reading a
 * JSON answer as script or HTML. Neither changes a status, a body or any
 * other header, so no caller (the gateway, an OAuth client fetching the JWKS)
 * sees a difference.
 *
 * No `includeSubDomains`: the deployment's host is not ours to speak for
 * beneath.
 */

import { httpActionGeneric, type HttpRouter } from "convex/server";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
};

/** The same response with the security headers set, kept where a handler already chose one. */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!headers.has(name)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

type RouteSpec = Parameters<HttpRouter["route"]>[0];

const DISCOVERY_CACHE = "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400";

function siteUrl(): string {
  const url = process.env.CONVEX_SITE_URL;
  if (!url) throw new Error("CONVEX_SITE_URL is not set");
  return url;
}

function discoveryDocument(body: string): Response {
  return withSecurityHeaders(
    new Response(body, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": DISCOVERY_CACHE } }),
  );
}

/**
 * The auth library's two discovery documents, answered here with the security
 * headers: the same bodies, status and caching `@convex-dev/auth` serves
 * (`addHttpRoutes`), whose responses we cannot add a header to. The library
 * still registers every other route it has (none while sign-in is OTP only);
 * only these two paths are taken over, so its copies are never registered.
 *
 * Built by hand rather than by wrapping the library's handlers: a wrapper
 * would have to call a registered function's internals directly, which the
 * credential-reachability analysis (`__tests__/structure/`) rightly refuses.
 */
const DISCOVERY_ROUTES: Record<string, () => Response> = {
  "/.well-known/openid-configuration": () =>
    discoveryDocument(
      JSON.stringify({
        issuer: siteUrl(),
        jwks_uri: siteUrl() + "/.well-known/jwks.json",
        authorization_endpoint: siteUrl() + "/oauth/authorize",
      }),
    ),
  "/.well-known/jwks.json": () => {
    const jwks = process.env.JWKS;
    if (!jwks) throw new Error("JWKS is not set");
    return discoveryDocument(jwks);
  },
};

export function addAuthHttpRoutes(http: HttpRouter, addHttpRoutes: (router: HttpRouter) => void): void {
  for (const [path, answer] of Object.entries(DISCOVERY_ROUTES)) {
    http.route({ path, method: "GET", handler: httpActionGeneric(async () => answer()) });
  }
  const rest = {
    route(spec: RouteSpec) {
      if ("path" in spec && spec.path !== undefined && spec.path in DISCOVERY_ROUTES) return;
      http.route(spec);
    },
  };
  addHttpRoutes(rest as unknown as HttpRouter);
}
