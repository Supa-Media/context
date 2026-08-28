/**
 * Dropbox's half of "connect your Dropbox", as pure functions over a stubbed
 * socket.
 *
 * Four things have to hold, and only the first is about Dropbox at all:
 *
 *  1. **The PKCE challenge is the right transformation.** Every other property
 *     of this module is checkable by reading it; this one is not. A challenge
 *     that is plain base64, or hex, or the SHA-1 of the verifier, produces a
 *     working-looking authorize URL and fails at the token exchange with an
 *     `invalid_grant` — indistinguishable from a code that expired. So it is
 *     pinned to the published vector in RFC 7636 §4.6 rather than to itself.
 *  2. **No code, verifier, or token reaches an error.** The inputs to every
 *     call here are credentials, and a thrown error is the shortest path from
 *     one to a log line, a Sentry event, or a screen. There is a test below
 *     that stuffs each of them into Dropbox's `error_description` and then
 *     searches the whole error object for them.
 *  3. **`invalid_grant` is not a transient failure.** The caller has to tell
 *     "reconnect your Dropbox" from "try again in a minute", and a revoked
 *     grant retried forever is a person who never finds out their connection
 *     is dead.
 *  4. **Nothing secret is in a URL.** The exchange is a POST with a form body;
 *     a query string carrying a code or a verifier would be recorded by every
 *     proxy between here and Dropbox.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { describe, expect, test } from "vitest";
import {
  DROPBOX_AUTHORIZE_ENDPOINT,
  DROPBOX_REVOKE_ENDPOINT,
  DROPBOX_SCOPES,
  DROPBOX_TOKEN_ENDPOINT,
  DropboxOAuthError,
  createPkcePair,
  dropboxAuthorizeUrl,
  exchangeDropboxCode,
  isDropboxReconnectRequired,
  pkceChallengeFor,
  refreshDropboxToken,
  revokeDropboxToken,
} from "../functions/lib/dropboxOAuth";

/* -------------------------------------------------------------------------- */
/*                          obviously fake constants                          */
/* -------------------------------------------------------------------------- */

/** A Dropbox app key is public by construction, but this one is still fake. */
const FAKE_CLIENT_ID = "notarealdropboxkey";
const FAKE_REDIRECT_URI = "https://app.context.invalid/connect/dropbox";
/** Distinctive enough that a substring search for it cannot match by accident. */
const FAKE_CODE = "FAKE-AUTHORIZATION-CODE-zzzzzzzzzzzz";
const FAKE_VERIFIER = "FAKE-CODE-VERIFIER-yyyyyyyyyyyyyyyyyyyyyyyyyyyy";
const FAKE_ACCESS_TOKEN = "sl.FAKE-ACCESS-TOKEN-xxxxxxxxxxxxxxxx";
const FAKE_REFRESH_TOKEN = "FAKE-REFRESH-TOKEN-wwwwwwwwwwwwwwww";
const FAKE_ROTATED_REFRESH_TOKEN = "FAKE-ROTATED-REFRESH-TOKEN-vvvvvvvv";
const FAKE_ACCOUNT_ID = "dbid:FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
const FAKE_STATE = "fake-opaque-state-value";

/** RFC 7636 §4.6, verbatim. The one thing here that is not ours to choose. */
const RFC7636_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC7636_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/* -------------------------------------------------------------------------- */
/*                                 fetch stubs                                */
/* -------------------------------------------------------------------------- */

interface RecordedCall {
  url: string;
  init: RequestInit;
  body: URLSearchParams;
}

/**
 * A `fetch` that answers once with `status` and `body`, and records what it was
 * asked. Injected rather than stubbed globally: this module takes its socket as
 * a parameter precisely so a test never has to reach for `vi.stubGlobal`.
 */
function stubFetch(status: number, body: unknown, contentType = "application/json") {
  const calls: RecordedCall[] = [];
  const impl = async (input: string, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      init,
      body: new URLSearchParams(String(init.body ?? "")),
    });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": contentType },
    });
  };
  return { impl, calls };
}

/**
 * Everything about a thrown value that could conceivably be read by a human or
 * a log shipper, flattened into one string.
 *
 * Deliberately more than `error.message`: the requirement is that a credential
 * never reaches *any* loggable string, and `JSON.stringify(err)` is what a
 * structured logger actually serialises.
 */
function everythingLoggable(error: unknown): string {
  const err = error as Error & Record<string, unknown>;
  return [
    String(error),
    err?.message ?? "",
    err?.stack ?? "",
    JSON.stringify(error),
    JSON.stringify({ ...err }),
    Object.values(err ?? {}).map(String).join(" "),
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/*                                    PKCE                                    */
/* -------------------------------------------------------------------------- */

describe("PKCE", () => {
  /**
   * The one assertion in this file that cannot be replaced by reading the code.
   *
   * SHA-256 of the ASCII verifier, base64url, no padding. Get any link in that
   * chain wrong — hash the wrong bytes, keep the `=`, keep `+` and `/` — and
   * the pair is still internally consistent, still produces a URL Dropbox
   * accepts, and fails only at the exchange.
   */
  test("challenge matches the RFC 7636 §4.6 vector", async () => {
    expect(await pkceChallengeFor(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE);
  });

  test("a generated pair is self-consistent", async () => {
    const pair = await createPkcePair();
    expect(await pkceChallengeFor(pair.verifier)).toBe(pair.challenge);
  });

  test("the verifier is RFC-legal and unreserved", async () => {
    const { verifier } = await createPkcePair();
    // RFC 7636 §4.1: 43–128 characters from the unreserved set.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  test("verifiers differ across calls", async () => {
    const pairs = await Promise.all(
      Array.from({ length: 16 }, () => createPkcePair()),
    );
    const verifiers = new Set(pairs.map((pair) => pair.verifier));
    expect(verifiers.size).toBe(pairs.length);
    // And the challenge is not a constant either, which a hardcoded return
    // would satisfy the test above with.
    expect(new Set(pairs.map((pair) => pair.challenge)).size).toBe(pairs.length);
  });

  test("a challenge is base64url with no padding", async () => {
    const { challenge } = await createPkcePair();
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("a verifier outside the RFC's length bounds is refused", async () => {
    await expect(pkceChallengeFor("too-short")).rejects.toThrow();
    await expect(pkceChallengeFor("a".repeat(129))).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/*                               authorize URL                                */
/* -------------------------------------------------------------------------- */

describe("authorize URL", () => {
  test("carries every parameter Dropbox needs, and the exact scopes", () => {
    const url = new URL(
      dropboxAuthorizeUrl({
        clientId: FAKE_CLIENT_ID,
        redirectUri: FAKE_REDIRECT_URI,
        challenge: RFC7636_CHALLENGE,
        state: FAKE_STATE,
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(DROPBOX_AUTHORIZE_ENDPOINT);
    expect(url.searchParams.get("client_id")).toBe(FAKE_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(FAKE_REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe(RFC7636_CHALLENGE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // Without this there is no refresh token, and the connection dies silently
    // four hours later.
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe(FAKE_STATE);

    expect(url.searchParams.get("scope")).toBe(
      "files.content.read files.content.write files.metadata.read files.metadata.write account_info.read",
    );
    expect([...DROPBOX_SCOPES]).toEqual([
      "files.content.read",
      "files.content.write",
      "files.metadata.read",
      "files.metadata.write",
      "account_info.read",
    ]);
  });

  test("the verifier is never in the authorize URL", async () => {
    const { verifier, challenge } = await createPkcePair();
    const url = dropboxAuthorizeUrl({
      clientId: FAKE_CLIENT_ID,
      redirectUri: FAKE_REDIRECT_URI,
      challenge,
      state: FAKE_STATE,
    });
    // The whole point of S256 over `plain`: what travels through the browser is
    // the digest, and the browser never sees the preimage.
    expect(url).not.toContain(verifier);
    expect(url).toContain(challenge);
  });

  test("always forces the consent screen, so a reconnect can switch accounts", () => {
    const url = new URL(
      dropboxAuthorizeUrl({
        clientId: FAKE_CLIENT_ID,
        redirectUri: FAKE_REDIRECT_URI,
        challenge: RFC7636_CHALLENGE,
        state: FAKE_STATE,
      }),
    );
    // Without this, Dropbox silently auto-approves an app it has already
    // authorized and bounces straight back — the person disconnecting to
    // switch accounts never sees the page where switching happens. Seyi hit
    // exactly that loop on the first live reconnect.
    expect(url.searchParams.get("force_reapprove")).toBe("true");
  });

  test("refuses a state-less request", () => {
    expect(() =>
      dropboxAuthorizeUrl({
        clientId: FAKE_CLIENT_ID,
        redirectUri: FAKE_REDIRECT_URI,
        challenge: RFC7636_CHALLENGE,
        state: "",
      }),
    ).toThrow(/state/i);
  });

  test("refuses a redirect URI that is not https or loopback", () => {
    expect(() =>
      dropboxAuthorizeUrl({
        clientId: FAKE_CLIENT_ID,
        redirectUri: "http://attacker.invalid/connect/dropbox",
        challenge: RFC7636_CHALLENGE,
        state: FAKE_STATE,
      }),
    ).toThrow(/redirect/i);
  });

  test("accepts the loopback redirect used for local development", () => {
    const url = dropboxAuthorizeUrl({
      clientId: FAKE_CLIENT_ID,
      redirectUri: "http://localhost:4601/connect/dropbox",
      challenge: RFC7636_CHALLENGE,
      state: FAKE_STATE,
    });
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(
      "http://localhost:4601/connect/dropbox",
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                                  exchange                                  */
/* -------------------------------------------------------------------------- */

describe("code exchange", () => {
  /** What Dropbox actually answers a PKCE exchange with. */
  const SUCCESS_BODY = {
    access_token: FAKE_ACCESS_TOKEN,
    token_type: "bearer",
    expires_in: 14400,
    refresh_token: FAKE_REFRESH_TOKEN,
    scope:
      "account_info.read files.content.read files.content.write files.metadata.read files.metadata.write",
    uid: "0000000",
    account_id: FAKE_ACCOUNT_ID,
  };

  test("parses a realistic success body", async () => {
    const { impl } = stubFetch(200, SUCCESS_BODY);
    const before = Date.now();
    const result = await exchangeDropboxCode({
      clientId: FAKE_CLIENT_ID,
      code: FAKE_CODE,
      verifier: FAKE_VERIFIER,
      redirectUri: FAKE_REDIRECT_URI,
      fetchImpl: impl,
    });

    expect(result.accessToken).toBe(FAKE_ACCESS_TOKEN);
    expect(result.refreshToken).toBe(FAKE_REFRESH_TOKEN);
    expect(result.accountId).toBe(FAKE_ACCOUNT_ID);
    // Epoch ms, not seconds, and not the raw `expires_in`.
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 14400 * 1000);
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 14400 * 1000);
  });

  test("posts a form body to the token endpoint and puts nothing in the URL", async () => {
    const { impl, calls } = stubFetch(200, SUCCESS_BODY);
    await exchangeDropboxCode({
      clientId: FAKE_CLIENT_ID,
      code: FAKE_CODE,
      verifier: FAKE_VERIFIER,
      redirectUri: FAKE_REDIRECT_URI,
      fetchImpl: impl,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe(DROPBOX_TOKEN_ENDPOINT);
    // No query string at all: a code or verifier in a URL is recorded by every
    // proxy, gateway and access log between here and Dropbox.
    expect(call.url).not.toContain("?");
    expect(call.init.method).toBe("POST");

    expect(call.body.get("grant_type")).toBe("authorization_code");
    expect(call.body.get("code")).toBe(FAKE_CODE);
    expect(call.body.get("code_verifier")).toBe(FAKE_VERIFIER);
    expect(call.body.get("client_id")).toBe(FAKE_CLIENT_ID);
    expect(call.body.get("redirect_uri")).toBe(FAKE_REDIRECT_URI);
    // A public client has no secret, and sending an empty one is a 400.
    expect(call.body.get("client_secret")).toBeNull();
  });

  test("an absent expires_in reads as already expired, never as NaN", async () => {
    const { expires_in: _dropped, ...noExpiry } = SUCCESS_BODY;
    const { impl } = stubFetch(200, noExpiry);
    const result = await exchangeDropboxCode({
      clientId: FAKE_CLIENT_ID,
      code: FAKE_CODE,
      verifier: FAKE_VERIFIER,
      redirectUri: FAKE_REDIRECT_URI,
      fetchImpl: impl,
    });
    expect(Number.isFinite(result.expiresAt)).toBe(true);
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now());
  });

  test("an absurd expires_in is capped rather than believed", async () => {
    const { impl } = stubFetch(200, { ...SUCCESS_BODY, expires_in: 1e12 });
    const result = await exchangeDropboxCode({
      clientId: FAKE_CLIENT_ID,
      code: FAKE_CODE,
      verifier: FAKE_VERIFIER,
      redirectUri: FAKE_REDIRECT_URI,
      fetchImpl: impl,
    });
    // Both ways of being wrong about an expiry resolve to "refresh sooner than
    // necessary"; believing this one would cache a dead token for 31,000 years.
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  test("a 200 that is missing a documented field is refused, not half-stored", async () => {
    for (const missing of ["access_token", "refresh_token", "account_id"] as const) {
      const body: Record<string, unknown> = { ...SUCCESS_BODY };
      delete body[missing];
      const { impl } = stubFetch(200, body);
      const error = await exchangeDropboxCode({
        clientId: FAKE_CLIENT_ID,
        code: FAKE_CODE,
        verifier: FAKE_VERIFIER,
        redirectUri: FAKE_REDIRECT_URI,
        fetchImpl: impl,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DropboxOAuthError);
      expect((error as DropboxOAuthError).errorCode).toBe("RESPONSE_UNUSABLE");
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                                   refresh                                  */
/* -------------------------------------------------------------------------- */

describe("refresh", () => {
  test("parses a realistic success body with no rotation", async () => {
    const { impl, calls } = stubFetch(200, {
      access_token: FAKE_ACCESS_TOKEN,
      token_type: "bearer",
      expires_in: 14400,
    });
    const before = Date.now();
    const result = await refreshDropboxToken({
      clientId: FAKE_CLIENT_ID,
      refreshToken: FAKE_REFRESH_TOKEN,
      fetchImpl: impl,
    });

    expect(result.accessToken).toBe(FAKE_ACCESS_TOKEN);
    // Dropbox usually does not rotate. `undefined` means "keep the one you
    // have", and must never be confused with "the refresh token is now empty".
    expect(result.refreshToken).toBeUndefined();
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 14400 * 1000);

    expect(calls[0].body.get("grant_type")).toBe("refresh_token");
    expect(calls[0].body.get("refresh_token")).toBe(FAKE_REFRESH_TOKEN);
    expect(calls[0].body.get("client_id")).toBe(FAKE_CLIENT_ID);
    expect(calls[0].url).not.toContain("?");
  });

  test("surfaces a rotated refresh token when one comes back", async () => {
    const { impl } = stubFetch(200, {
      access_token: FAKE_ACCESS_TOKEN,
      token_type: "bearer",
      expires_in: 14400,
      refresh_token: FAKE_ROTATED_REFRESH_TOKEN,
    });
    const result = await refreshDropboxToken({
      clientId: FAKE_CLIENT_ID,
      refreshToken: FAKE_REFRESH_TOKEN,
      fetchImpl: impl,
    });
    expect(result.refreshToken).toBe(FAKE_ROTATED_REFRESH_TOKEN);
  });

  test("a refresh token echoed back unchanged is reported as no rotation", async () => {
    const { impl } = stubFetch(200, {
      access_token: FAKE_ACCESS_TOKEN,
      expires_in: 14400,
      refresh_token: FAKE_REFRESH_TOKEN,
    });
    const result = await refreshDropboxToken({
      clientId: FAKE_CLIENT_ID,
      refreshToken: FAKE_REFRESH_TOKEN,
      fetchImpl: impl,
    });
    // Not a rotation, so the caller must not be told to re-encrypt and rewrite
    // a row for a value that did not change.
    expect(result.refreshToken).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                        errors: safe, and distinguishable                   */
/* -------------------------------------------------------------------------- */

describe("errors", () => {
  /**
   * The guard this module exists to keep.
   *
   * Dropbox's `error_description` is free text we do not control, and it
   * arrives on the one call whose every input is a credential. Here it is made
   * hostile — it contains the code, the verifier and both tokens — and the
   * assertion is over the entire flattened error object, not just `.message`.
   */
  test("no code, verifier, or token reaches anything loggable", async () => {
    const hostile = [
      FAKE_CODE,
      FAKE_VERIFIER,
      FAKE_ACCESS_TOKEN,
      FAKE_REFRESH_TOKEN,
    ].join(" ");
    const { impl } = stubFetch(400, {
      error: "invalid_grant",
      error_description: `code ${hostile} was rejected`,
    });

    const error = await exchangeDropboxCode({
      clientId: FAKE_CLIENT_ID,
      code: FAKE_CODE,
      verifier: FAKE_VERIFIER,
      redirectUri: FAKE_REDIRECT_URI,
      fetchImpl: impl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DropboxOAuthError);
    const loggable = everythingLoggable(error);
    for (const secret of [
      FAKE_CODE,
      FAKE_VERIFIER,
      FAKE_ACCESS_TOKEN,
      FAKE_REFRESH_TOKEN,
    ]) {
      expect(loggable).not.toContain(secret);
    }
    // And it still says something useful.
    expect((error as DropboxOAuthError).message.length).toBeGreaterThan(0);
    expect((error as DropboxOAuthError).providerErrorCode).toBe("invalid_grant");
  });

  test("a refresh failure leaks nothing either", async () => {
    const { impl } = stubFetch(400, {
      error: "invalid_grant",
      error_description: `refresh_token ${FAKE_REFRESH_TOKEN} is revoked`,
    });
    const error = await refreshDropboxToken({
      clientId: FAKE_CLIENT_ID,
      refreshToken: FAKE_REFRESH_TOKEN,
      fetchImpl: impl,
    }).catch((caught: unknown) => caught);

    expect(everythingLoggable(error)).not.toContain(FAKE_REFRESH_TOKEN);
  });

  /**
   * A provider error slug is only ever kept when it is a bare OAuth-style
   * identifier. Anything else — and a credential is very much anything else —
   * is dropped rather than retained under a name that reads as safe.
   */
  test("a provider error slug that is not slug-shaped is dropped", async () => {
    const { impl } = stubFetch(400, {
      error: `not a slug: ${FAKE_REFRESH_TOKEN}`,
      error_description: "whatever",
    });
    const error = await refreshDropboxToken({
      clientId: FAKE_CLIENT_ID,
      refreshToken: FAKE_REFRESH_TOKEN,
      fetchImpl: impl,
    }).catch((caught: unknown) => caught);

    expect((error as DropboxOAuthError).providerErrorCode).toBeUndefined();
    expect(everythingLoggable(error)).not.toContain(FAKE_REFRESH_TOKEN);
  });

  test("invalid_grant is a revoked grant, and says so", async () => {
    const { impl } = stubFetch(400, {
      error: "invalid_grant",
      error_description: "refresh token is invalid or revoked",
    });
    const error = await refreshDropboxToken({
      clientId: FAKE_CLIENT_ID,
      refreshToken: FAKE_REFRESH_TOKEN,
      fetchImpl: impl,
    }).catch((caught: unknown) => caught);

    expect((error as DropboxOAuthError).errorCode).toBe("GRANT_REVOKED");
    expect((error as DropboxOAuthError).reconnectRequired).toBe(true);
    expect(isDropboxReconnectRequired(error)).toBe(true);
  });

  test("a 500 is transient, and is NOT a revoked grant", async () => {
    const { impl } = stubFetch(500, "<html>upstream is having a day</html>", "text/html");
    const error = await refreshDropboxToken({
      clientId: FAKE_CLIENT_ID,
      refreshToken: FAKE_REFRESH_TOKEN,
      fetchImpl: impl,
    }).catch((caught: unknown) => caught);

    expect((error as DropboxOAuthError).errorCode).toBe("DROPBOX_UNAVAILABLE");
    expect((error as DropboxOAuthError).reconnectRequired).toBe(false);
    // The distinction the caller branches on. If these two ever collapse, a
    // person whose Dropbox is disconnected is told to try again, forever.
    expect(isDropboxReconnectRequired(error)).toBe(false);
  });

  test("a 429 is transient too", async () => {
    const { impl } = stubFetch(429, { error: "too_many_requests" });
    const error = await refreshDropboxToken({
      clientId: FAKE_CLIENT_ID,
      refreshToken: FAKE_REFRESH_TOKEN,
      fetchImpl: impl,
    }).catch((caught: unknown) => caught);
    expect((error as DropboxOAuthError).errorCode).toBe("DROPBOX_UNAVAILABLE");
    expect(isDropboxReconnectRequired(error)).toBe(false);
  });

  test("a misconfigured client is neither transient nor a revoked grant", async () => {
    const { impl } = stubFetch(400, { error: "invalid_client" });
    const error = await refreshDropboxToken({
      clientId: FAKE_CLIENT_ID,
      refreshToken: FAKE_REFRESH_TOKEN,
      fetchImpl: impl,
    }).catch((caught: unknown) => caught);

    // Telling somebody to reconnect will not fix our app registration, and
    // retrying will not either.
    expect((error as DropboxOAuthError).errorCode).toBe("REQUEST_REJECTED");
    expect(isDropboxReconnectRequired(error)).toBe(false);
  });

  test("a socket that never answers is transient", async () => {
    const impl = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await refreshDropboxToken({
      clientId: FAKE_CLIENT_ID,
      refreshToken: FAKE_REFRESH_TOKEN,
      fetchImpl: impl,
    }).catch((caught: unknown) => caught);

    expect((error as DropboxOAuthError).errorCode).toBe("DROPBOX_UNAVAILABLE");
    expect(isDropboxReconnectRequired(error)).toBe(false);
  });

  test("isDropboxReconnectRequired says no to things that are not our error", () => {
    expect(isDropboxReconnectRequired(new Error("invalid_grant"))).toBe(false);
    expect(isDropboxReconnectRequired("invalid_grant")).toBe(false);
    expect(isDropboxReconnectRequired(null)).toBe(false);
    expect(isDropboxReconnectRequired(undefined)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   revoke                                   */
/* -------------------------------------------------------------------------- */

describe("revoke", () => {
  test("posts the token as a bearer header to the revoke endpoint, and nowhere else", async () => {
    const { impl, calls } = stubFetch(200, null);
    await revokeDropboxToken({ accessToken: FAKE_ACCESS_TOKEN, fetchImpl: impl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(DROPBOX_REVOKE_ENDPOINT);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`);
    // Not in the URL, where it would land in every proxy log on the path.
    expect(calls[0].url).not.toContain(FAKE_ACCESS_TOKEN);
  });

  test("an already-dead token is the outcome revocation wanted", async () => {
    const { impl } = stubFetch(401, { error_summary: "invalid_access_token/..." });
    await expect(
      revokeDropboxToken({ accessToken: FAKE_ACCESS_TOKEN, fetchImpl: impl }),
    ).resolves.toBeUndefined();
  });

  test("a live refusal throws, and the throw carries no token", async () => {
    const { impl } = stubFetch(500, { error_summary: "internal_error/." });
    let thrown: unknown;
    try {
      await revokeDropboxToken({ accessToken: FAKE_ACCESS_TOKEN, fetchImpl: impl });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DropboxOAuthError);
    expect(JSON.stringify({ ...(thrown as object), message: (thrown as Error).message }))
      .not.toContain(FAKE_ACCESS_TOKEN);
  });
});
