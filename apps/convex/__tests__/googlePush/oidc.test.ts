import { beforeEach, describe, expect, test } from "vitest";
import { pubsubTokenIsValid, resetGoogleCertCache } from "../../functions/lib/googlePush/oidc";
import { AUDIENCE, PUSH_ACCOUNT, fakeGoogleSigner, pushClaims } from "./fixtures.helpers";

/**
 * Who may push. Each refusal below is a sabotage this suite catches: drop
 * the check it names from `pubsubTokenIsValid` and exactly that test fails.
 */
describe("a Pub/Sub push token", () => {
  beforeEach(() => resetGoogleCertCache());

  async function check(token: string | null, signerFetch: typeof fetch) {
    return await pubsubTokenIsValid({
      authorization: token === null ? null : `Bearer ${token}`,
      audience: AUDIENCE,
      serviceAccount: PUSH_ACCOUNT,
      fetchImpl: signerFetch,
    });
  }

  test("signed by Google, for this endpoint, as our push account, is accepted", async () => {
    const google = await fakeGoogleSigner();
    expect(await check(await google.sign(pushClaims()), google.fetchImpl as typeof fetch)).toBe(true);
  });

  test.each([
    ["another audience", { aud: "https://elsewhere.example.invalid/push" }],
    ["another service account", { email: "someone-else@example-project.iam.gserviceaccount.com" }],
    ["an unverified email", { email_verified: false }],
    ["an issuer that is not Google", { iss: "https://issuer.example.invalid" }],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ["a token issued in the future", { iat: Math.floor(Date.now() / 1000) + 3600 }],
  ])("is refused with %s", async (_, overrides) => {
    const google = await fakeGoogleSigner();
    expect(await check(await google.sign(pushClaims(overrides)), google.fetchImpl as typeof fetch)).toBe(false);
  });

  test("is refused when signed by any key but Google's", async () => {
    const google = await fakeGoogleSigner();
    const impostor = await fakeGoogleSigner(google.kid);
    expect(await check(await impostor.sign(pushClaims()), google.fetchImpl as typeof fetch)).toBe(false);
  });

  test("is refused when its claims were changed after signing", async () => {
    const google = await fakeGoogleSigner();
    const [header, , signature] = (await google.sign(pushClaims({ email: "attacker@example.invalid" }))).split(".");
    const forgedClaims = btoa(JSON.stringify(pushClaims())).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await check(`${header}.${forgedClaims}.${signature}`, google.fetchImpl as typeof fetch)).toBe(false);
  });

  test("never takes its algorithm from the token", async () => {
    const google = await fakeGoogleSigner();
    const none = await google.sign(pushClaims(), { alg: "none", kid: google.kid });
    expect(await check(none, google.fetchImpl as typeof fetch)).toBe(false);
    const hs = await google.sign(pushClaims(), { alg: "HS256", kid: google.kid });
    expect(await check(hs, google.fetchImpl as typeof fetch)).toBe(false);
  });

  test("is refused with no token, or something that is not one", async () => {
    const google = await fakeGoogleSigner();
    expect(await check(null, google.fetchImpl as typeof fetch)).toBe(false);
    expect(await check("not-a-jwt", google.fetchImpl as typeof fetch)).toBe(false);
  });

  test("fetches Google's keys once, and once more only for a key it has not seen", async () => {
    const google = await fakeGoogleSigner();
    const token = await google.sign(pushClaims());
    await check(token, google.fetchImpl as typeof fetch);
    await check(token, google.fetchImpl as typeof fetch);
    expect(google.certFetches()).toBe(1);
    const unknownKid = await google.sign(pushClaims(), { alg: "RS256", kid: "rotated-away" });
    expect(await check(unknownKid, google.fetchImpl as typeof fetch)).toBe(false);
    expect(google.certFetches()).toBe(2);
  });

  test("refuses rather than throws when Google's keys cannot be fetched", async () => {
    const google = await fakeGoogleSigner();
    const down = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    expect(await check(await google.sign(pushClaims()), down)).toBe(false);
  });
});
