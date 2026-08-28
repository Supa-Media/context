/**
 * Dropbox OAuth, as pure functions.
 *
 * Everything here is either a string transformation, a Web Crypto digest, or
 * one `fetch` against Dropbox's token endpoint. Nothing here reads or writes
 * the database, nothing holds a credential beyond the call it was passed to,
 * and nothing here is a Convex function — which is what makes it testable
 * against a stubbed socket rather than against Dropbox.
 *
 * ## Why PKCE and no client secret
 *
 * The Dropbox app is registered as a **public client**, so there is no client
 * secret anywhere in this system — not in Convex, not in the gateway, not on a
 * device. The only thing that binds the authorization code to the browser that
 * started the flow is the PKCE pair: a high-entropy `verifier` we keep, and the
 * SHA-256 of it that travels through the browser as the `challenge`. Somebody
 * who intercepts the redirect gets a code they cannot spend.
 *
 * That makes exactly one thing load-bearing and invisible: **the challenge must
 * be `base64url(SHA-256(ascii(verifier)))`, unpadded.** Plain base64, hex, a
 * padded digest, or hashing the wrong bytes all produce a challenge Dropbox
 * accepts at the authorize step and rejects at the exchange, as `invalid_grant`
 * — which is byte-identical to the error for a code that expired. There is no
 * way to tell those apart in production, so the transformation is pinned in the
 * tests to RFC 7636 §4.6's published vector rather than to itself.
 *
 * ## Why a `code_verifier` must never be stored where a browser can reach it
 *
 * The verifier is the whole proof. Parked server-side, keyed by the `state`
 * value, it is a secret nobody else can read; put in `localStorage` or a
 * fragment it is readable by anything else running on that origin, and PKCE
 * degrades to no protection at all. This module generates it and hands it back;
 * where it is parked is the caller's decision and the caller's risk.
 *
 * ## Why nothing provider-written ends up in an error
 *
 * Every input to `exchangeDropboxCode` and `refreshDropboxToken` is a
 * credential, and a thrown error is the shortest path from one to a log line, a
 * Sentry event, or a screen. Dropbox's `error_description` is free text we do
 * not control, so it is **dropped entirely** rather than passed through:
 * keeping it would make "no secret reaches a log" a property of Dropbox's prose
 * instead of a property of this file.
 *
 * What survives is the machine-readable `error` slug, and only when it is
 * shaped like one (`/^[a-z][a-z0-9_]*$/`, at most 64 characters). That is a
 * closed enough shape to be worth having in support logs, and the validation is
 * what makes it provably not a credential rather than merely unlikely to be
 * one.
 *
 * ## Why a revoked grant is its own error code
 *
 * The caller has to answer a person with one of two different sentences —
 * "reconnect your Dropbox" or "try again in a minute" — and it cannot get that
 * from an HTTP status: Dropbox answers a revoked refresh token with the same
 * `400` it uses for a malformed request. `invalid_grant` is the signal, it is
 * terminal, and a background refresh loop that retries it forever is how
 * somebody's connection stays dead without anybody finding out.
 *
 * References (documentation, not credentials):
 *  - https://developers.dropbox.com/oauth-guide
 *  - https://www.dropbox.com/developers/documentation/http/documentation#oauth2-token
 *  - RFC 7636 (PKCE), RFC 6749 §5.2 (token error responses)
 */

import { redirectUriIsAcceptable } from "./gatewayAuth";

/* -------------------------------------------------------------------------- */
/* Endpoints and scopes                                                       */
/* -------------------------------------------------------------------------- */

/** Where the person's browser goes to approve. A `www.dropbox.com` page. */
export const DROPBOX_AUTHORIZE_ENDPOINT = "https://www.dropbox.com/oauth2/authorize";

/**
 * Where codes and refresh tokens are spent. A different host from the authorize
 * page, and a different one again from the content host the store adapter uses.
 */
export const DROPBOX_TOKEN_ENDPOINT = "https://api.dropboxapi.com/oauth2/token";

/**
 * The scopes the app asks for, and the complete list of them.
 *
 * The app is registered as **Scoped App / App Folder**, so even
 * `files.content.write` reaches only the app's own folder — the consent screen
 * says so in those words, and it is the reason this is a one-click connect
 * rather than a conversation about handing us a whole Dropbox.
 *
 * `account_info.read` is not decoration: it is what makes `account_id` on the
 * token response meaningful, which is how the console can say whose Dropbox
 * this is and detect somebody reconnecting a *different* account over an
 * existing binding.
 *
 * Narrowing this list later is a breaking change for existing grants — Dropbox
 * issues tokens for the scopes approved at consent time, so a token minted
 * before a scope was added does not gain it on refresh.
 */
export const DROPBOX_SCOPES = [
  "files.content.read",
  "files.content.write",
  "files.metadata.read",
  "files.metadata.write",
  "account_info.read",
] as const;

/* -------------------------------------------------------------------------- */
/* PKCE                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Bytes of entropy behind a verifier.
 *
 * 32 bytes base64url-encode to exactly 43 characters, which is RFC 7636 §4.1's
 * minimum. The RFC's floor and a 256-bit secret coincide here, so there is
 * nothing to trade off: this is the shortest legal verifier and it is already
 * as strong as the digest that stands in for it.
 */
const VERIFIER_BYTES = 32;

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
const MIN_VERIFIER_LENGTH = 43;
const MAX_VERIFIER_LENGTH = 128;

/** A PKCE pair. The verifier is a secret; the challenge is not. */
export interface PkcePair {
  /** Kept server-side, spent once at the exchange. Never sent to a browser. */
  verifier: string;
  /** `base64url(SHA-256(verifier))`. Safe to put in a URL — that is the point. */
  challenge: string;
}

/** Bytes → base64url, unpadded. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // `btoa` is the one base64 primitive present in all three runtimes this code
  // has to work in: the Convex action runtime, the Workers gateway, and
  // `@edge-runtime/vm` under vitest. `Buffer` is in none of them reliably.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The `code_challenge` for a given verifier.
 *
 * Exported because it is the only way to check this transformation against
 * something other than itself: `createPkcePair` alone can only be tested for
 * self-consistency, and a self-consistent wrong hash is exactly the bug this
 * closes. The test feeds it RFC 7636 §4.6's published verifier and asserts the
 * RFC's published challenge.
 *
 * The length bounds are checked here rather than only at generation, because
 * this is also the function a caller would reach for if it ever wanted to
 * re-derive a challenge for a verifier that came from somewhere else.
 */
export async function pkceChallengeFor(verifier: string): Promise<string> {
  if (
    typeof verifier !== "string" ||
    verifier.length < MIN_VERIFIER_LENGTH ||
    verifier.length > MAX_VERIFIER_LENGTH
  ) {
    // Says nothing about the value, which is a secret, and everything about the
    // rule it broke.
    throw new Error(
      `A PKCE code verifier must be ${MIN_VERIFIER_LENGTH}–${MAX_VERIFIER_LENGTH} characters (RFC 7636 §4.1)`,
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    // ASCII, per RFC 7636 §4.2. The verifiers this module generates are
    // base64url so the encoding is moot for them, but it is not moot for a
    // verifier that came from anywhere else.
    new TextEncoder().encode(verifier) as BufferSource,
  );
  return base64Url(new Uint8Array(digest));
}

/**
 * A fresh PKCE pair.
 *
 * `crypto.getRandomValues` rather than `Math.random`, for the same reason
 * `randomOpaqueToken` in `gatewayAuth.ts` uses it: `Math.random` is seeded per
 * transaction in the Convex runtime and is not a CSPRNG. A guessable verifier
 * is a PKCE flow with no PKCE in it.
 */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(VERIFIER_BYTES)));
  return { verifier, challenge: await pkceChallengeFor(verifier) };
}

/* -------------------------------------------------------------------------- */
/* The authorize URL                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Where to send somebody's browser to approve the connection.
 *
 * `state` is required, not optional. It is the only thing tying the redirect
 * that comes back to the flow that started it — without it, an attacker can
 * feed a victim's browser a redirect carrying the *attacker's* authorization
 * code and silently bind the victim's workspace to the attacker's Dropbox. An
 * optional CSRF token is a CSRF token somebody will omit.
 *
 * The redirect URI is checked against the same https-or-loopback rule the OAuth
 * server side applies (`redirectUriIsAcceptable`), rather than a second copy of
 * it. Today it is a configured constant and not attacker-controlled; the check
 * costs one branch and means it stays safe if that ever stops being true.
 */
export function dropboxAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  /** `challenge` from `createPkcePair`, never the verifier. */
  challenge: string;
  state: string;
}): string {
  if (typeof options.state !== "string" || options.state.length === 0) {
    throw new Error("A Dropbox authorize URL needs a state value");
  }
  if (!redirectUriIsAcceptable(options.redirectUri)) {
    throw new Error("A Dropbox redirect URI must be https, or http on loopback");
  }

  const url = new URL(DROPBOX_AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // WITHOUT THIS THERE IS NO REFRESH TOKEN. Dropbox's default is a short-lived
  // access token and nothing else, so a connection made without it works
  // perfectly for four hours and then dies with no way back except asking the
  // person to reconnect — a failure that shows up long after the change that
  // caused it.
  url.searchParams.set("token_access_type", "offline");
  url.searchParams.set("scope", DROPBOX_SCOPES.join(" "));
  url.searchParams.set("state", options.state);
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How a token call failed, as something a caller can branch on.
 *
 *  - `GRANT_REVOKED`        — `invalid_grant`. The code was spent or expired,
 *                             or the refresh token was revoked (the person
 *                             disconnected us in Dropbox, or deleted the app
 *                             folder). **Terminal. Reconnect.**
 *  - `REQUEST_REJECTED`     — Dropbox understood and refused: a wrong client
 *                             id, a redirect URI that does not match the one
 *                             registered, a malformed request. Our bug or our
 *                             configuration; neither retrying nor reconnecting
 *                             fixes it.
 *  - `DROPBOX_UNAVAILABLE`  — 5xx, 429, a deadline, or no answer at all. Retry.
 *  - `RESPONSE_UNUSABLE`    — a 2xx whose body is not the documented shape.
 *                             Refused rather than half-stored; see
 *                             `readTokenResponse`.
 */
export type DropboxOAuthErrorCode =
  | "GRANT_REVOKED"
  | "REQUEST_REJECTED"
  | "DROPBOX_UNAVAILABLE"
  | "RESPONSE_UNUSABLE";

/**
 * A Dropbox OAuth failure, already classified.
 *
 * Carries no code, no verifier, and no token — not in the message, not in a
 * field, not in a `cause`. Its whole surface is a closed error code, a sentence
 * written here, and optionally a slug-shaped provider identifier.
 */
export class DropboxOAuthError extends Error {
  readonly errorCode: DropboxOAuthErrorCode;
  /**
   * `true` only for `GRANT_REVOKED`. Stored rather than derived at the call
   * site so that two callers cannot disagree about which codes mean reconnect.
   */
  readonly reconnectRequired: boolean;
  /**
   * Dropbox's own `error` slug, when it was slug-shaped. Absent otherwise —
   * including when Dropbox sent something that was not a slug, which is the
   * case a credential would have to arrive through.
   */
  readonly providerErrorCode?: string;

  constructor(
    errorCode: DropboxOAuthErrorCode,
    message: string,
    providerErrorCode?: string,
  ) {
    super(message);
    this.name = "DropboxOAuthError";
    this.errorCode = errorCode;
    this.reconnectRequired = errorCode === "GRANT_REVOKED";
    if (providerErrorCode !== undefined) this.providerErrorCode = providerErrorCode;
  }
}

/**
 * Does this failure mean the person has to reconnect their Dropbox?
 *
 * The one question the caller actually asks, answered without it having to know
 * the error taxonomy or `instanceof` anything. Anything that is not one of our
 * errors answers `false`: an unrecognised failure is not evidence that a grant
 * was revoked, and telling somebody their Dropbox is disconnected when it is
 * not sends them to re-approve for nothing.
 */
export function isDropboxReconnectRequired(error: unknown): boolean {
  return error instanceof DropboxOAuthError && error.reconnectRequired;
}

/** An OAuth error identifier, and nothing that could be a credential. */
const PROVIDER_ERROR_SLUG = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Classify a non-2xx token response.
 *
 * The slug comes first and the status second, for the same reason
 * `classifyCloudflareFailure` reads codes before statuses: Dropbox answers a
 * revoked grant and a malformed request with the same `400`, so the status
 * alone cannot tell "reconnect" from "we have a bug".
 */
function classifyTokenFailure(
  status: number,
  slug: string | undefined,
): DropboxOAuthError {
  if (slug === "invalid_grant") {
    return new DropboxOAuthError(
      "GRANT_REVOKED",
      "Dropbox no longer accepts this authorization. Reconnect Dropbox to continue.",
      slug,
    );
  }
  // 429 before the 5xx check because it is a 4xx, and it is the one 4xx here
  // that is transient. Dropbox rate-limits the token endpoint like any other.
  if (status === 429 || status >= 500) {
    return new DropboxOAuthError(
      "DROPBOX_UNAVAILABLE",
      "Dropbox did not answer. Try again shortly.",
      slug,
    );
  }
  return new DropboxOAuthError(
    "REQUEST_REJECTED",
    "Dropbox refused the request.",
    slug,
  );
}

/* -------------------------------------------------------------------------- */
/* The token endpoint                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The socket, injectable.
 *
 * Defaults to the global `fetch`. Taking it as a parameter is what lets the
 * tests exercise the real parsing and the real classification without a global
 * stub, and without any of the module's inputs ever leaving the process.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * How long one token call may take.
 *
 * Same reasoning as the Cloudflare module's deadline: a request that hangs
 * holds an action open and holds a decrypted refresh token in memory for the
 * duration. Guarded rather than assumed, because this runs in three runtimes
 * and a missing deadline is a slower failure rather than a wrong one.
 */
const REQUEST_TIMEOUT_MS = 15_000;

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
}

/** What Dropbox documents a token response as carrying. All optional here. */
interface TokenResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  account_id?: unknown;
  error?: unknown;
}

/**
 * One POST to the token endpoint, classified on the way out.
 *
 * The parameters go in a form body and never in the URL. That is not a style
 * choice: a query string is recorded by every proxy, load balancer and access
 * log on the path, and the values here are an authorization code, a code
 * verifier, and a refresh token.
 */
async function postToken(
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<TokenResponseBody> {
  const signal = timeoutSignal();
  let response: Response;
  try {
    response = await fetchImpl(DROPBOX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(params).toString(),
      ...(signal ? { signal } : {}),
    });
  } catch {
    // The thrown value is discarded rather than inspected. A network error's
    // message can contain the request it was making, and this request's body is
    // three credentials.
    throw new DropboxOAuthError(
      "DROPBOX_UNAVAILABLE",
      "Dropbox could not be reached. Try again shortly.",
    );
  }

  let body: TokenResponseBody = {};
  try {
    const raw = await response.text();
    // A body that is not JSON is still a failure to classify, and the status is
    // all we have to go on. The raw text is never kept: an HTML error page from
    // an intermediary can echo the request back.
    body = raw.length === 0 ? {} : (JSON.parse(raw) as TokenResponseBody);
  } catch {
    body = {};
  }

  if (!response.ok) {
    const rawSlug = body.error;
    const slug =
      typeof rawSlug === "string" && PROVIDER_ERROR_SLUG.test(rawSlug)
        ? rawSlug
        : undefined;
    throw classifyTokenFailure(response.status, slug);
  }
  return body;
}

/**
 * The furthest out we are willing to believe an access token lives.
 *
 * Dropbox's short-lived tokens are four hours. A day is generous headroom for
 * that changing, and it bounds the one thing an unbounded `expires_in` would
 * cost us: a token cached past its death, which the gateway then spends a
 * request discovering is dead, over and over, for as long as the number said.
 */
const MAX_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Turn `expires_in` seconds into an epoch-ms deadline.
 *
 * An absent or nonsensical value reads as **already expired** rather than as an
 * error or as some invented default. The direction that fails in is "refresh
 * more often than necessary", which costs a round trip and self-heals; the
 * alternatives are throwing away a grant that works, or caching a token past
 * its death and serving 401s from the gateway.
 *
 * The cap is the same reasoning applied to the other end. Both ways of being
 * wrong here resolve to "refresh sooner than strictly necessary", which is the
 * only direction that cannot strand somebody.
 */
function expiryFromSeconds(expiresIn: unknown, now: number): number {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return now;
  }
  return now + Math.min(expiresIn * 1000, MAX_TOKEN_LIFETIME_MS);
}

/** A non-empty string field, or `undefined`. Never coerced. */
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** What a completed authorization gives us. Everything but `expiresAt` is secret. */
export interface DropboxTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms, derived from `expires_in`. */
  expiresAt: number;
  /** `dbid:…`. Not a secret; identifies whose Dropbox this is. */
  accountId: string;
}

/**
 * Spend an authorization code for a token set.
 *
 * `redirect_uri` is sent again even though the code already came back to it:
 * RFC 6749 §4.1.3 requires it when it was present at the authorize step, and
 * Dropbox enforces that. Omitting it is a `400` that looks like a bad code.
 *
 * There is no `client_secret`. This is a public client, and sending an empty
 * one is refused rather than ignored.
 *
 * A 200 that is missing any documented field is refused instead of partially
 * accepted. A binding written from half a response is a binding whose "which
 * account is this?" or "how do we refresh?" question has no answer and never
 * will; the person retrying a connect is a cheap, recoverable alternative.
 */
export async function exchangeDropboxCode(options: {
  clientId: string;
  code: string;
  /** The `verifier` from the `createPkcePair` whose challenge started this flow. */
  verifier: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
}): Promise<DropboxTokenSet> {
  const body = await postToken(
    {
      grant_type: "authorization_code",
      code: options.code,
      code_verifier: options.verifier,
      client_id: options.clientId,
      redirect_uri: options.redirectUri,
    },
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
  );

  const accessToken = stringOrUndefined(body.access_token);
  const refreshToken = stringOrUndefined(body.refresh_token);
  const accountId = stringOrUndefined(body.account_id);

  if (accessToken === undefined || refreshToken === undefined || accountId === undefined) {
    // Names the missing field and not its neighbours' values. A refresh token
    // absent here almost always means `token_access_type=offline` was dropped
    // from the authorize URL, which is worth being loud about — that failure
    // would otherwise surface four hours later as a dead connection.
    const missing = [
      accessToken === undefined ? "access_token" : null,
      refreshToken === undefined ? "refresh_token" : null,
      accountId === undefined ? "account_id" : null,
    ]
      .filter((name): name is string => name !== null)
      .join(", ");
    throw new DropboxOAuthError(
      "RESPONSE_UNUSABLE",
      `Dropbox returned a token response with no ${missing}.`,
    );
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: expiryFromSeconds(body.expires_in, Date.now()),
    accountId,
  };
}

/** What a refresh gives us. `refreshToken` is present only on a rotation. */
export interface DropboxRefreshResult {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
  /**
   * A **new** refresh token, when Dropbox rotated one. `undefined` means the
   * stored one is still good — never "there is no refresh token now".
   */
  refreshToken?: string;
}

/**
 * Trade a refresh token for a fresh access token.
 *
 * Dropbox's documented response carries `access_token` and `expires_in` and
 * usually nothing else, but rotation is permitted by RFC 6749 §6 and providers
 * turn it on without notice. Both shapes are handled, and they are reported
 * differently on purpose: `refreshToken` comes back **only when the value
 * actually changed**, so a caller can treat its presence as "re-encrypt and
 * rewrite the row" without rewriting one on every refresh, and an echoed-back
 * identical token does not masquerade as a rotation.
 *
 * The failure this exists to distinguish is `invalid_grant` — the person
 * disconnected the app in Dropbox, or deleted the app folder. That is terminal
 * and needs a human; everything transient is retryable. See
 * `isDropboxReconnectRequired`.
 */
export async function refreshDropboxToken(options: {
  clientId: string;
  refreshToken: string;
  fetchImpl?: FetchLike;
}): Promise<DropboxRefreshResult> {
  const body = await postToken(
    {
      grant_type: "refresh_token",
      refresh_token: options.refreshToken,
      client_id: options.clientId,
    },
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
  );

  const accessToken = stringOrUndefined(body.access_token);
  if (accessToken === undefined) {
    throw new DropboxOAuthError(
      "RESPONSE_UNUSABLE",
      "Dropbox returned a refresh response with no access_token.",
    );
  }

  const rotated = stringOrUndefined(body.refresh_token);
  return {
    accessToken,
    expiresAt: expiryFromSeconds(body.expires_in, Date.now()),
    ...(rotated !== undefined && rotated !== options.refreshToken
      ? { refreshToken: rotated }
      : {}),
  };
}
