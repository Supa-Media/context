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

import { httpActionGeneric, type HttpRouter, type PublicHttpAction } from "convex/server";

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
type Handler = (ctx: unknown, request: Request) => Promise<Response>;

/**
 * A router whose every route answers with the security headers, for routes a
 * library registers (`auth.addHttpRoutes`), whose responses we do not build.
 * Each handler is the library's own, called as Convex calls it.
 */
export function securedRouter(http: HttpRouter): HttpRouter {
  return new Proxy(http, {
    get(target, property, receiver) {
      if (property !== "route") return Reflect.get(target, property, receiver);
      return (spec: RouteSpec) => {
        const inner = (spec.handler as PublicHttpAction & { _handler?: Handler })._handler;
        if (typeof inner !== "function") return target.route(spec);
        const handler = httpActionGeneric(async (ctx, request) => withSecurityHeaders(await inner(ctx, request)));
        return target.route({ ...spec, handler } as RouteSpec);
      };
    },
  });
}
