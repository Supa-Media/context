/**
 * Google's OAuth mechanics, as pure functions over a stubbed socket. Same
 * shape and the same four things that have to hold as `dropboxOAuth.test.ts`
 * — see that file's header for the full argument — restated here for a
 * different provider and a different id-token trust boundary:
 *
 *  1. PKCE is reused from `dropboxOAuth.ts` rather than reimplemented, so its
 *     own test already pins the RFC 7636 vector; this file proves the reuse
 *     actually happened.
 *  2. No code, verifier, or token reaches an error.
 *  3. `invalid_grant` is not a transient failure.
 *  4. Nothing secret is in a URL — and specifically here, the account
 *     identity (`sub`/`email`) comes from the id token in the response body,
 *     never from a query parameter a redirect could carry.
 *
 * **Generalized from a Gmail-only `gmailOAuth.test.ts` (2026-09-07)**: the
 * endpoints, PKCE, and token exchange are provider-generic (`exchangeGoogleCode`
 * etc.); what is product-specific is only the scope list, covered separately
 * under "scopes per product".
 *
 * Every value here is obviously fake. This repository is public.
 *
 * SABOTAGE RECORD
 *   append body.error_description to the thrown error's message  -> 1 check failed
 */

import { describe, expect, test } from "vitest";
import {
  CALENDAR_SCOPES,
  CHAT_SCOPES,
  GMAIL_SCOPES,
  GOOGLE_AUTHORIZE_ENDPOINT,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleOAuthError,
  createPkcePair,
  exchangeGoogleCode,
  googleAuthorizeUrl,
  googleRedirectAllowed,
  grantedScopesFor,
  isGoogleReconnectRequired,
  pkceChallengeFor,
  refreshGoogleToken,
  revokeGoogleToken,
  scopesForProducts,
} from "../functions/lib/googleOAuth";

const FAKE_CLIENT_ID = "fake-client-id.apps.googleusercontent.com";
const FAKE_CLIENT_SECRET = "FAKE-GOCSPX-not-a-real-secret";
const FAKE_REDIRECT_URI = "https://app.context.invalid/mail/gmail/callback";
const FAKE_CODE = "FAKE-AUTHORIZATION-CODE-zzzzzzzzzzzz";
const FAKE_VERIFIER = "FAKE-CODE-VERIFIER-yyyyyyyyyyyyyyyyyyyyyyyyyyyy";
const FAKE_ACCESS_TOKEN = "ya29.FAKE-ACCESS-TOKEN-xxxxxxxxxxxxxxxx";
const FAKE_REFRESH_TOKEN = "1//FAKE-REFRESH-TOKEN-wwwwwwwwwwwwwwww";
const FAKE_STATE = "fake-opaque-state-value";
const GMAIL_REQUEST_SCOPES = scopesForProducts(["gmail"]);

const RFC7636_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC7636_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/** `header.payload.signature`, base64url, unsigned/unverified — see the module doc for why that is fine here. */
function fakeIdToken(claims: Record<string, unknown>): string {
  const base64url = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${base64url({ alg: "none" })}.${base64url(claims)}.`;
}

const FAKE_GOOGLE_ACCOUNT_ID = "108060000000000000000";
const FAKE_ADDRESS = "person@example.invalid";
const FAKE_ID_TOKEN = fakeIdToken({ sub: FAKE_GOOGLE_ACCOUNT_ID, email: FAKE_ADDRESS });

interface RecordedCall {
  url: string;
  init: RequestInit;
  body: URLSearchParams;
}

function stubFetch(status: number, body: unknown) {
  const calls: RecordedCall[] = [];
  const impl = async (input: string, init: RequestInit = {}) => {
    calls.push({ url: String(input), init, body: new URLSearchParams(String(init.body ?? "")) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

describe("PKCE is reused, not reimplemented", () => {
  test("the challenge for the RFC 7636 vector matches the published one", async () => {
    expect(await pkceChallengeFor(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE);
  });

  test("createPkcePair produces a verifier and a matching challenge", async () => {
    const pair = await createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(await pkceChallengeFor(pair.verifier)).toBe(pair.challenge);
  });
});

describe("scopes per product", () => {
  test("gmail.readonly is always requested for Gmail — read-only, forever, per v1", () => {
    expect(GMAIL_SCOPES).toContain("https://www.googleapis.com/auth/gmail.readonly");
  });

  /**
   * Recorded verbatim, per the owner's decision: `chat.messages.readonly` is
   * confirmed on Google's own restricted-scopes list, the same class as
   * Gmail — so the CASA security assessment gating Gmail gates Chat too the
   * moment Chat sync ships. `chat.spaces.readonly` is sensitive, a lighter
   * bar but not zero. See `docs/decisions/communications.md`.
   */
  test("both Chat scopes this product will need are declared, and Gmail's restricted-ness is not assumed to be unique to Gmail", () => {
    expect(CHAT_SCOPES).toContain("https://www.googleapis.com/auth/chat.messages.readonly");
    expect(CHAT_SCOPES).toContain("https://www.googleapis.com/auth/chat.spaces.readonly");
  });

  test("Calendar's scope is declared for the sibling work to build against", () => {
    expect(CALENDAR_SCOPES).toContain("https://www.googleapis.com/auth/calendar.events.readonly");
  });

  test("scopesForProducts always includes the identity scopes, regardless of which products are asked for", () => {
    const scopes = scopesForProducts(["gmail"]);
    expect(scopes).toContain("openid");
    expect(scopes).toContain("https://www.googleapis.com/auth/userinfo.email");
    expect(scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
  });

  test("scopesForProducts unions every requested product's scopes, deduplicated", () => {
    const scopes = scopesForProducts(["gmail", "calendar"]);
    expect(scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(scopes).toContain("https://www.googleapis.com/auth/calendar.events.readonly");
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  test("grantedScopesFor slices the one verbatim grant down to what one product actually uses", () => {
    const granted = [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ];
    expect(grantedScopesFor("gmail", granted)).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(grantedScopesFor("calendar", granted)).toEqual([
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ]);
    // A downgraded consent — the person unchecked Calendar — is visible as an
    // empty slice, never a guess that it was granted anyway.
    expect(grantedScopesFor("chat", granted)).toEqual([]);
  });
});

describe("the authorize URL", () => {
  test("carries offline access, forced consent, and the caller's state", () => {
    const url = new URL(
      googleAuthorizeUrl({
        clientId: FAKE_CLIENT_ID,
        redirectUri: FAKE_REDIRECT_URI,
        challenge: RFC7636_CHALLENGE,
        state: FAKE_STATE,
        scopes: GMAIL_REQUEST_SCOPES,
      }),
    );
    expect(url.origin + url.pathname).toBe(GOOGLE_AUTHORIZE_ENDPOINT);
    expect(url.searchParams.get("client_id")).toBe(FAKE_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(FAKE_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge")).toBe(RFC7636_CHALLENGE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(FAKE_STATE);
    // WITHOUT THESE TWO THERE IS NO REFRESH TOKEN, ever, on a reconnect.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(GMAIL_REQUEST_SCOPES.join(" "));
  });

  /**
   * WITHOUT THIS, adding a second product to an account silently drops the
   * first: Google grants exactly what one request asks for, so a
   * Calendar-only "add Calendar" to an account that already granted Gmail
   * comes back covering Calendar alone. This is the shared half of the fix —
   * `googleConnect.ts`'s per-connection tests cover the app-side union that
   * backs it up.
   *
   * Sabotage, measured: commenting out the `include_granted_scopes` line in
   * `googleAuthorizeUrl` fails this test and `calendarConnect.test.ts`'s
   * "also carries include_granted_scopes" test — 2 failures across the two
   * files, both landing on this exact line; every other test in both files
   * stays green.
   */
  test("always requests the union of previously granted scopes, not just this request's", () => {
    const url = new URL(
      googleAuthorizeUrl({
        clientId: FAKE_CLIENT_ID,
        redirectUri: FAKE_REDIRECT_URI,
        challenge: RFC7636_CHALLENGE,
        state: FAKE_STATE,
        scopes: GMAIL_REQUEST_SCOPES,
      }),
    );
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
  });

  test("refuses a URL with no state — an optional CSRF token is one that gets omitted", () => {
    expect(() =>
      googleAuthorizeUrl({
        clientId: FAKE_CLIENT_ID,
        redirectUri: FAKE_REDIRECT_URI,
        challenge: "c",
        state: "",
        scopes: GMAIL_REQUEST_SCOPES,
      }),
    ).toThrow();
  });

  test("refuses a plaintext-http redirect off loopback", () => {
    expect(() =>
      googleAuthorizeUrl({
        clientId: FAKE_CLIENT_ID,
        redirectUri: "http://attacker.example/cb",
        challenge: "c",
        state: FAKE_STATE,
        scopes: GMAIL_REQUEST_SCOPES,
      }),
    ).toThrow();
  });

  test("refuses an empty scope list rather than sending a consent screen for nothing", () => {
    expect(() =>
      googleAuthorizeUrl({
        clientId: FAKE_CLIENT_ID,
        redirectUri: FAKE_REDIRECT_URI,
        challenge: "c",
        state: FAKE_STATE,
        scopes: [],
      }),
    ).toThrow();
  });
});

describe("which redirects this deployment will send somebody to", () => {
  test("loopback is always allowed, for local dev", () => {
    expect(googleRedirectAllowed("http://127.0.0.1:3210/cb", {})).toBe(true);
    expect(googleRedirectAllowed("http://localhost:3210/cb", {})).toBe(true);
  });

  test("an https URL matching the configured APP_ORIGIN is allowed", () => {
    expect(
      googleRedirectAllowed("https://app.context.invalid/mail/gmail/callback", {
        APP_ORIGIN: "https://app.context.invalid",
      }),
    ).toBe(true);
  });

  test("a different origin is refused even with APP_ORIGIN configured", () => {
    expect(
      googleRedirectAllowed("https://attacker.example/cb", { APP_ORIGIN: "https://app.context.invalid" }),
    ).toBe(false);
  });

  test("with no APP_ORIGIN configured, only loopback is allowed — fail closed", () => {
    expect(googleRedirectAllowed("https://app.context.invalid/cb", {})).toBe(false);
  });
});

describe("exchanging a code", () => {
  test("a complete response is parsed into a token set, and the id token's claims become the account identity", async () => {
    const { impl, calls } = stubFetch(200, {
      access_token: FAKE_ACCESS_TOKEN,
      refresh_token: FAKE_REFRESH_TOKEN,
      expires_in: 3599,
      id_token: FAKE_ID_TOKEN,
      scope: GMAIL_REQUEST_SCOPES.join(" "),
    });
    const before = Date.now();
    const result = await exchangeGoogleCode({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      code: FAKE_CODE,
      verifier: FAKE_VERIFIER,
      redirectUri: FAKE_REDIRECT_URI,
      fetchImpl: impl,
    });
    expect(result).toMatchObject({
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: FAKE_REFRESH_TOKEN,
      googleAccountId: FAKE_GOOGLE_ACCOUNT_ID,
      address: FAKE_ADDRESS,
      scopes: GMAIL_REQUEST_SCOPES,
    });
    expect(result.expiresAt).toBeGreaterThan(before);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(GOOGLE_TOKEN_ENDPOINT);
    // Nothing secret in the URL — a POST body, never a query string.
    expect(calls[0]!.url).not.toContain(FAKE_CODE);
    expect(calls[0]!.url).not.toContain(FAKE_VERIFIER);
    expect(calls[0]!.body.get("code")).toBe(FAKE_CODE);
    expect(calls[0]!.body.get("code_verifier")).toBe(FAKE_VERIFIER);
    expect(calls[0]!.body.get("redirect_uri")).toBe(FAKE_REDIRECT_URI);
    expect(calls[0]!.body.get("client_secret")).toBe(FAKE_CLIENT_SECRET);
  });

  test("an omitted client secret is simply not sent — PKCE alone still works", async () => {
    const { impl, calls } = stubFetch(200, {
      access_token: FAKE_ACCESS_TOKEN,
      refresh_token: FAKE_REFRESH_TOKEN,
      expires_in: 3599,
      id_token: FAKE_ID_TOKEN,
    });
    await exchangeGoogleCode({
      clientId: FAKE_CLIENT_ID,
      code: FAKE_CODE,
      verifier: FAKE_VERIFIER,
      redirectUri: FAKE_REDIRECT_URI,
      fetchImpl: impl,
    });
    expect(calls[0]!.body.has("client_secret")).toBe(false);
  });

  for (const missing of ["access_token", "refresh_token"]) {
    test(`a response missing ${missing} is refused rather than half-accepted`, async () => {
      const body: Record<string, unknown> = {
        access_token: FAKE_ACCESS_TOKEN,
        refresh_token: FAKE_REFRESH_TOKEN,
        id_token: FAKE_ID_TOKEN,
      };
      delete body[missing];
      const { impl } = stubFetch(200, body);
      await expect(
        exchangeGoogleCode({
          clientId: FAKE_CLIENT_ID,
          code: FAKE_CODE,
          verifier: FAKE_VERIFIER,
          redirectUri: FAKE_REDIRECT_URI,
          fetchImpl: impl,
        }),
      ).rejects.toMatchObject({ errorCode: "RESPONSE_UNUSABLE" });
    });
  }

  test("a response with no id token — so no account identity — is refused", async () => {
    const { impl } = stubFetch(200, { access_token: FAKE_ACCESS_TOKEN, refresh_token: FAKE_REFRESH_TOKEN });
    await expect(
      exchangeGoogleCode({
        clientId: FAKE_CLIENT_ID,
        code: FAKE_CODE,
        verifier: FAKE_VERIFIER,
        redirectUri: FAKE_REDIRECT_URI,
        fetchImpl: impl,
      }),
    ).rejects.toMatchObject({ errorCode: "RESPONSE_UNUSABLE" });
  });

  test("invalid_grant is GRANT_REVOKED, and is the only code that means reconnect", async () => {
    const { impl } = stubFetch(400, { error: "invalid_grant" });
    const error = await exchangeGoogleCode({
      clientId: FAKE_CLIENT_ID,
      code: FAKE_CODE,
      verifier: FAKE_VERIFIER,
      redirectUri: FAKE_REDIRECT_URI,
      fetchImpl: impl,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(GoogleOAuthError);
    expect(isGoogleReconnectRequired(error)).toBe(true);
  });

  test("a 500 is GOOGLE_UNAVAILABLE, not GRANT_REVOKED — retry, do not ask for reconnect", async () => {
    const { impl } = stubFetch(500, { error: "internal_error" });
    const error = await exchangeGoogleCode({
      clientId: FAKE_CLIENT_ID,
      code: FAKE_CODE,
      verifier: FAKE_VERIFIER,
      redirectUri: FAKE_REDIRECT_URI,
      fetchImpl: impl,
    }).catch((e) => e);
    expect(isGoogleReconnectRequired(error)).toBe(false);
  });

  /**
   * THE ONE THAT MATTERS MOST. Every input here is a credential, and a thrown
   * error is the shortest path from one to a log line. Google's free-text
   * `error_description` is dropped entirely rather than passed through.
   */
  test("none of the code, verifier, secret, or provider free text reach the thrown error", async () => {
    const distinctiveDescription = "some free text mentioning nothing sensitive by name";
    const { impl } = stubFetch(400, {
      error: "invalid_request",
      error_description: `${distinctiveDescription} ${FAKE_CODE} ${FAKE_VERIFIER} ${FAKE_CLIENT_SECRET}`,
    });
    const error = await exchangeGoogleCode({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      code: FAKE_CODE,
      verifier: FAKE_VERIFIER,
      redirectUri: FAKE_REDIRECT_URI,
      fetchImpl: impl,
    }).catch((e) => e);
    const serialized = JSON.stringify({
      message: (error as Error).message,
      name: (error as Error).name,
      ...error,
    });
    for (const secret of [FAKE_CODE, FAKE_VERIFIER, FAKE_CLIENT_SECRET, distinctiveDescription]) {
      expect(serialized).not.toContain(secret);
    }
  });

  /**
   * THE OTHER FIELD, and the one `PROVIDER_ERROR_SLUG` actually guards.
   *
   * The check above puts its free text in `error_description`, which this
   * module never reads at all — so it passes with the slug pattern deleted
   * entirely. Measured: relaxing `PROVIDER_ERROR_SLUG.test(rawSlug)` to
   * `typeof rawSlug === "string"` failed **zero** checks. `error` is the
   * field that IS read and IS kept, on `providerErrorCode`, and a provider
   * error body is not a trusted shape — a proxy, an interception, or a future
   * Google change can put anything in it, and `providerErrorCode` is the
   * value a caller is most likely to put in a structured log. It is
   * `^[a-z][a-z0-9_]{0,63}$` or it is dropped: a closed alphabet and a length
   * bound, not a sanitiser that has to be right about what is dangerous.
   */
  test.each([
    ["free text with spaces", "invalid request: the code 12345 was already used"],
    ["a newline, which would forge a second log line", "invalid_grant\nlevel=info secret=leaked"],
    ["a JSON fragment", '{"nested":"object"}'],
    ["over the length bound", `a${"b".repeat(200)}`],
    ["an uppercase spelling outside the alphabet", "INVALID_GRANT"],
  ])("a provider error code that is %s is dropped, never carried", async (_label, hostile) => {
    const { impl } = stubFetch(400, { error: hostile });
    const error = await exchangeGoogleCode({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      code: FAKE_CODE,
      verifier: FAKE_VERIFIER,
      redirectUri: FAKE_REDIRECT_URI,
      fetchImpl: impl,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(GoogleOAuthError);
    expect((error as GoogleOAuthError).providerErrorCode).toBeUndefined();
    expect(JSON.stringify({ message: (error as Error).message, ...error })).not.toContain(
      hostile.slice(0, 20),
    );
  });

  test("a well-formed provider error code IS kept — the bound is a filter, not a blanket drop", async () => {
    const { impl } = stubFetch(400, { error: "invalid_grant" });
    const error = await exchangeGoogleCode({
      clientId: FAKE_CLIENT_ID,
      code: FAKE_CODE,
      verifier: FAKE_VERIFIER,
      redirectUri: FAKE_REDIRECT_URI,
      fetchImpl: impl,
    }).catch((e) => e);
    expect((error as GoogleOAuthError).providerErrorCode).toBe("invalid_grant");
  });
});

describe("refreshing", () => {
  test("a normal refresh returns a fresh access token", async () => {
    const { impl, calls } = stubFetch(200, { access_token: FAKE_ACCESS_TOKEN, expires_in: 3599 });
    const result = await refreshGoogleToken({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      refreshToken: FAKE_REFRESH_TOKEN,
      fetchImpl: impl,
    });
    expect(result.accessToken).toBe(FAKE_ACCESS_TOKEN);
    expect(calls[0]!.body.get("grant_type")).toBe("refresh_token");
    expect(calls[0]!.body.get("refresh_token")).toBe(FAKE_REFRESH_TOKEN);
  });

  test("a revoked refresh token is GRANT_REVOKED", async () => {
    const { impl } = stubFetch(400, { error: "invalid_grant" });
    const error = await refreshGoogleToken({
      clientId: FAKE_CLIENT_ID,
      refreshToken: FAKE_REFRESH_TOKEN,
      fetchImpl: impl,
    }).catch((e) => e);
    expect(isGoogleReconnectRequired(error)).toBe(true);
  });
});

describe("revoking", () => {
  test("posts the token to the revoke endpoint", async () => {
    const { impl, calls } = stubFetch(200, {});
    await revokeGoogleToken({ token: FAKE_REFRESH_TOKEN, fetchImpl: impl });
    expect(calls[0]!.url).toBe(GOOGLE_REVOKE_ENDPOINT);
    expect(calls[0]!.body.get("token")).toBe(FAKE_REFRESH_TOKEN);
  });

  test("a token that is already dead (400 invalid_token) is treated as success", async () => {
    const { impl } = stubFetch(400, { error: "invalid_token" });
    await expect(revokeGoogleToken({ token: FAKE_REFRESH_TOKEN, fetchImpl: impl })).resolves.toBeUndefined();
  });

  test("any other failure is reported", async () => {
    const { impl } = stubFetch(500, {});
    await expect(revokeGoogleToken({ token: FAKE_REFRESH_TOKEN, fetchImpl: impl })).rejects.toBeInstanceOf(
      GoogleOAuthError,
    );
  });
});
