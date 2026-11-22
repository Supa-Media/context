/**
 * A preview's control plane reaches Google through its emulators (`functions/lib/emulators.ts`,
 * packages/emulators); staging and production never do, whatever EMULATORS_ORIGIN says.
 */
import { describe, expect, test } from "vitest";
import { emulatorsOrigin, installEmulators, outsideUrl } from "../functions/lib/emulators";
import { googleAuthorizeUrl } from "../functions/lib/googleOAuth";

const ORIGIN = "https://context-emulators-pr7.fake-sub.workers.dev";

describe("emulators on a preview only", () => {
  test("only APP_ENV=preview with an origin turns them on", () => {
    expect(emulatorsOrigin({ APP_ENV: "preview", EMULATORS_ORIGIN: ORIGIN })).toBe(ORIGIN);
    expect(emulatorsOrigin({ APP_ENV: "production", EMULATORS_ORIGIN: ORIGIN })).toBeNull();
    expect(emulatorsOrigin({ APP_ENV: "staging", EMULATORS_ORIGIN: ORIGIN })).toBeNull();
    expect(emulatorsOrigin({ APP_ENV: "preview" })).toBeNull();
  });

  test("Google URLs move to the emulators on a preview and stay put elsewhere", () => {
    const real = "https://accounts.google.com/o/oauth2/v2/auth";
    expect(outsideUrl(real, { APP_ENV: "preview", EMULATORS_ORIGIN: ORIGIN })).toBe(`${ORIGIN}/google/o/oauth2/v2/auth`);
    expect(outsideUrl(real, { APP_ENV: "production", EMULATORS_ORIGIN: ORIGIN })).toBe(real);
  });

  test("fetch is wrapped once on a preview and never elsewhere", async () => {
    const seen: string[] = [];
    const target = { fetch: (async (input: RequestInfo | URL) => (seen.push(String(input)), new Response("ok"))) as typeof fetch };
    expect(installEmulators({ APP_ENV: "production", EMULATORS_ORIGIN: ORIGIN }, target)).toBe(false);
    expect(installEmulators({ APP_ENV: "preview", EMULATORS_ORIGIN: ORIGIN }, target)).toBe(true);
    expect(installEmulators({ APP_ENV: "preview", EMULATORS_ORIGIN: ORIGIN }, target)).toBe(false);
    await target.fetch("https://oauth2.googleapis.com/token", { method: "POST" });
    expect(seen).toEqual([`${ORIGIN}/google/oauth2/token`]);
  });

  test("the authorize URL is Google's own outside a preview", () => {
    const url = new URL(googleAuthorizeUrl({ clientId: "c", redirectUri: "https://app.test/cb", scopes: ["openid"], state: "s", challenge: "x" }));
    expect(url.origin).toBe("https://accounts.google.com");
  });
});
