/**
 * HSTS and nosniff on the control plane's own HTTP answers
 * (`functions/lib/httpSecurityHeaders.ts`; CASA ZAP, 2026-10-29, flagged both
 * missing on `/.well-known/jwks.json`, `/.well-known/openid-configuration`,
 * `/gateway/binding`, `/gateway/session` and `/gateway/sessions/by-grant`).
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `auth.addHttpRoutes(http)` in place of `addAuthHttpRoutes` fails "the
 *     auth discovery documents ...".
 *  2. `gatewayRoute` returning `unauthorized()` bare fails "a refused gateway
 *     call carries them too".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { httpActionGeneric, httpRouter, type HttpRouter } from "convex/server";
import { addAuthHttpRoutes, SECURITY_HEADERS, withSecurityHeaders } from "../functions/lib/httpSecurityHeaders";
import { gatewayPost, setupTest } from "./fixtures.helpers";

function expectSecured(response: Response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers.get(name)).toBe(value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the control plane's HTTP answers carry HSTS and nosniff", () => {
  test("the auth discovery documents, unchanged otherwise", async () => {
    vi.stubEnv("CONVEX_SITE_URL", "https://control.context.invalid");
    vi.stubEnv("JWKS", JSON.stringify({ keys: [] }));
    const t = setupTest();
    for (const path of ["/.well-known/openid-configuration", "/.well-known/jwks.json"]) {
      const response = await t.fetch(path, { method: "GET" });
      expect(response.status).toBe(200);
      expectSecured(response);
      expect(response.headers.get("Content-Type")).toMatch(/application\/json/);
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=15, stale-while-revalidate=15, stale-if-error=86400");
    }
    const configuration = await t.fetch("/.well-known/openid-configuration", { method: "GET" });
    expect(await configuration.json()).toEqual({
      issuer: "https://control.context.invalid",
      jwks_uri: "https://control.context.invalid/.well-known/jwks.json",
      authorization_endpoint: "https://control.context.invalid/oauth/authorize",
    });
    const jwks = await t.fetch("/.well-known/jwks.json", { method: "GET" });
    expect(await jwks.text()).toBe(JSON.stringify({ keys: [] }));
  });

  test("every other route the auth library adds is still registered, the discovery paths once", () => {
    const http = httpRouter();
    const handler = httpActionGeneric(async () => new Response(null));
    addAuthHttpRoutes(http, (router: HttpRouter) => {
      router.route({ path: "/.well-known/jwks.json", method: "GET", handler });
      router.route({ path: "/.well-known/openid-configuration", method: "GET", handler });
      router.route({ pathPrefix: "/api/auth/signin/", method: "GET", handler });
    });
    expect(http.lookup("/api/auth/signin/google", "GET")?.[0]).toBe(handler);
    expect(http.lookup("/.well-known/jwks.json", "GET")?.[0]).not.toBe(handler);
  });

  test("a gateway answer, with its own no-store kept", async () => {
    const t = setupTest();
    for (const path of ["/gateway/session", "/gateway/sessions/by-grant", "/gateway/binding"]) {
      const response = await gatewayPost(t, path, {});
      expectSecured(response);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("a refused gateway call carries them too, and every refusal still looks the same", async () => {
    const t = setupTest();
    const none = await gatewayPost(t, "/gateway/session", {}, { secret: null });
    const wrong = await gatewayPost(t, "/gateway/session", {}, { secret: "not-the-secret" });
    expect(none.status).toBe(401);
    expectSecured(none);
    expect([...wrong.headers.entries()]).toEqual([...none.headers.entries()]);
    expect(await wrong.text()).toBe(await none.text());
  });
});

describe("withSecurityHeaders", () => {
  test("keeps the status, the body and every header, and a value a handler chose", async () => {
    const original = new Response("{\"ok\":true}", {
      status: 409,
      headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", "Strict-Transport-Security": "max-age=63072000" },
    });
    const secured = withSecurityHeaders(original);
    expect(secured.status).toBe(409);
    expect(secured.headers.get("Content-Type")).toBe("application/json");
    expect(secured.headers.get("Strict-Transport-Security")).toBe("max-age=63072000");
    expect(await secured.text()).toBe("{\"ok\":true}");
  });
});
