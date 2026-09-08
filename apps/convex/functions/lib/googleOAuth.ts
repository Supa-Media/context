/**
 * Google OAuth for a connected Google account, as pure functions.
 *
 * Same shape as `dropboxOAuth.ts` and the same reasons apply — everything
 * here is a string transformation, a Web Crypto digest, or one `fetch`
 * against Google's token endpoint, nothing does I/O beyond that, and nothing
 * here is a Convex function, so it is testable against a stubbed socket
 * rather than against Google. This file restates only what differs from that
 * module; see it for the fuller argument behind PKCE, the optional client
 * secret, and why a provider's free-text error is never passed through.
 *
 * **Generalized from a Gmail-only `gmailOAuth.ts` (2026-09-07)**: the
 * authorize/token/revoke endpoints, the PKCE flow, and the error taxonomy are
 * true of every Google product this account might connect — Gmail, Calendar,
 * Chat — because they are all one OAuth 2.0 client and one grant. Only the
 * *scopes requested* differ per product, so `GMAIL_SCOPES` stays named for
 * Gmail specifically and a sibling constant is added per product as that
 * product's sync ships; everything else in this file is already
 * product-agnostic and does not need touching to add one.
 *
 * ## Google's restricted scopes are why the whole connect flow is behind a flag
 *
 * `gmail.readonly` is a **restricted** scope under Google's API Services User
 * Data Policy: reading it in server-side storage requires app verification
 * and an independent third-party security assessment, and until that is
 * granted the consent screen Google shows is capped at 100 test users and
 * carries an "unverified app" interstitial. **`chat.messages.readonly` is
 * also restricted** — confirmed against Google's own restricted-scopes list,
 * not merely assumed alongside Gmail — so the same verification and CASA
 * assessment gates Chat too, the moment Chat sync ships; `chat.spaces.readonly`
 * is sensitive rather than restricted, a lighter bar but not zero. See
 * `docs/decisions/communications.md`, "The Gmail restricted scope is
 * Google's decision, so v1 runs on fixtures". `MAIL_CONNECT_ENABLED` in
 * `googleConnect.ts` is what keeps this whole flow reachable only where that
 * is acceptable.
 *
 * ## PKCE, reused rather than reimplemented
 *
 * `createPkcePair` is RFC 7636 with no Dropbox-specific behaviour in it, so
 * this module imports it from `dropboxOAuth.ts` instead of carrying a second
 * copy — the same reasoning `communications.md` gives for reusing
 * `normalizeRoot` rather than writing a third path validator: two
 * implementations of "hash this verifier correctly" is how one of them ends
 * up wrong first.
 *
 * ## Why the id token is trusted without verifying its signature
 *
 * The token response — access token, refresh token, and (with `openid` in
 * the scope) an id token — arrives over TLS directly from `oauth2.googleapis.com`
 * to this server, in response to a code only this server presented. That
 * channel is already the thing every credential in this file is trusted on;
 * an attacker able to forge Google's TLS response could hand back a forged
 * *access token* just as easily; verifying the id token's JWT signature would
 * add a second proof of a fact the channel already establishes. What it is
 * NOT trusted for: nothing here treats the id token as authorization for
 * anything a caller supplied — `sub` and `email` are read from it and
 * compared to nothing the caller sent, and both are metadata (an account
 * identifier, an address), never a credential.
 *
 * References (documentation, not credentials):
 *  - https://developers.google.com/identity/protocols/oauth2/web-server
 *  - https://developers.google.com/gmail/api/auth/scopes
 *  - https://support.google.com/cloud/answer/9110914 (restricted scopes)
 *  - https://support.google.com/cloud/answer/13464325 (restricted scopes list — confirms `chat.messages.readonly`)
 */

import { createPkcePair, pkceChallengeFor, type PkcePair } from "./dropboxOAuth";
import { APP_ORIGIN_ENV_VAR, redirectUriIsAcceptable } from "./gatewayAuth";

export type { PkcePair };
export { createPkcePair, pkceChallengeFor };

/* -------------------------------------------------------------------------- */
/* Endpoints — one OAuth 2.0 client, true for every product                  */
/* -------------------------------------------------------------------------- */

export const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/* -------------------------------------------------------------------------- */
/* Scopes — one constant per product, and the identity scopes every grant    */
/* needs regardless of which products are being requested                    */
/* -------------------------------------------------------------------------- */

/**
 * `openid` + `userinfo.email` are what make the id token carry a stable
 * account id and the address, without a second round trip to a userinfo
 * endpoint. Requested on every connect regardless of which products are
 * chosen — the account identity is not optional.
 */
export const IDENTITY_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email"] as const;

/**
 * `gmail.readonly` is the whole point and is a **restricted** scope (see
 * above). Read-only, on purpose and forever: v1 never sends, replies,
 * archives, deletes, or marks read — see the "What is deliberately not
 * built" section of `docs/decisions/communications.md`.
 */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"] as const;

/**
 * Not requested by any connect flow yet — declared for the sibling Calendar
 * work to build against, per `docs/decisions/communications.md`. Sensitive,
 * not restricted: a lighter verification bar than Gmail's, but not zero.
 */
export const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.events.readonly"] as const;

/**
 * Not requested by any connect flow yet — declared for the sibling Chat
 * work to build against. `chat.messages.readonly` is **restricted**, the
 * same class as Gmail; `chat.spaces.readonly` is sensitive. Both need
 * requesting together for a Chat connection to be useful (listing spaces to
 * read from, then reading them).
 */
export const CHAT_SCOPES = [
  "https://www.googleapis.com/auth/chat.messages.readonly",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
] as const;

/** Every product this account can connect, and the scopes each one needs. */
export const PRODUCT_SCOPES = {
  gmail: GMAIL_SCOPES,
  calendar: CALENDAR_SCOPES,
  chat: CHAT_SCOPES,
} as const;

export type GoogleProduct = keyof typeof PRODUCT_SCOPES;

/** The full scope list to request for a chosen set of products, identity scopes included, deduplicated. */
export function scopesForProducts(products: readonly GoogleProduct[]): string[] {
  const scopes = new Set<string>(IDENTITY_SCOPES);
  for (const product of products) for (const scope of PRODUCT_SCOPES[product]) scopes.add(scope);
  return [...scopes];
}

/**
 * Which of the granted scopes belong to one product — the per-product slice
 * `docs/decisions/communications.md` asks for, computed from the one
 * verbatim grant rather than carried as a second fact that could disagree
 * with it.
 */
export function grantedScopesFor(product: GoogleProduct, grantedScopes: readonly string[]): string[] {
  const wanted = new Set(PRODUCT_SCOPES[product]);
  return grantedScopes.filter((scope) => wanted.has(scope as never));
}

/* -------------------------------------------------------------------------- */
/* Redirect and authorize URL                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Is this a redirect URI we would ever send somebody to?
 *
 * Identical reasoning to `dropboxRedirectAllowed`: pinned to our own origin
 * (or loopback, for local dev) so an attacker cannot start their own connect
 * with a `redirectUri` they control and hand the victim the resulting
 * authorize URL — see that function's comment for the full confused-deputy
 * argument, which applies here unchanged.
 */
export function googleRedirectAllowed(
  redirectUri: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!redirectUriIsAcceptable(redirectUri)) return false;
  let presented: URL;
  try {
    presented = new URL(redirectUri);
  } catch {
    return false;
  }
  const loopback = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);
  if (loopback.has(presented.hostname)) return true;

  const configured = env[APP_ORIGIN_ENV_VAR];
  if (typeof configured !== "string" || configured.length === 0) return false;
  let allowed: URL;
  try {
    allowed = new URL(configured);
  } catch {
    return false;
  }
  return allowed.protocol === "https:" && presented.origin === allowed.origin;
}

export function googleAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  /** `challenge` from `createPkcePair`, never the verifier. */
  challenge: string;
  state: string;
  /** From `scopesForProducts`. Never a raw product-name array — this file does not know what a product is. */
  scopes: readonly string[];
}): string {
  if (typeof options.state !== "string" || options.state.length === 0) {
    throw new Error("A Google authorize URL needs a state value");
  }
  if (!redirectUriIsAcceptable(options.redirectUri)) {
    throw new Error("A Google redirect URI must be https, or http on loopback");
  }
  if (!Array.isArray(options.scopes) || options.scopes.length === 0) {
    throw new Error("A Google authorize URL needs at least one scope");
  }

  const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // WITHOUT THIS THERE IS NO REFRESH TOKEN. Google's default for a repeat
  // consent is to omit it; the whole point of connecting an account is a sync
  // that outlives the browser tab, so this is not optional here.
  url.searchParams.set("access_type", "offline");
  // Always show the consent screen, even for an account that has approved
  // this client before — otherwise a reconnect against a *different* Google
  // account can silently re-approve the one already signed in, and Google
  // omits the refresh token on a silent re-approval regardless, which is the
  // failure `access_type=offline` above exists to prevent.
  url.searchParams.set("prompt", "consent");
  // WITHOUT THIS, ADDING A PRODUCT SILENTLY DROPS EVERY OTHER ONE. Google
  // grants exactly what a request asks for: an "add Chat" request naming only
  // Chat's scopes gets back a refresh token that no longer covers Gmail, even
  // though the person never asked to disconnect Gmail — the new token simply
  // replaces the old one at the top level, and `applyGoogleConnectionBinding`
  // recomputes every product's scope slice from whatever this response
  // reports (correctly — see that function's comment on why a slice is never
  // carried forward), so a request that omits a product's scopes reports that
  // product as having none, which is the account's real state at that point,
  // not a display bug. `include_granted_scopes=true` is Google's own answer
  // to incremental authorization: the token this call gets back carries every
  // scope this client already held for this account, unioned with whatever
  // this request adds, regardless of which existing connection (if any) the
  // caller knew about when it built the request — the one fix that holds even
  // when the caller cannot know in advance which Google account will complete
  // the flow. See `docs/decisions/communications.md`, "Adding a product must
  // not silently drop another one".
  //
  // Both product flows that add a scope to an existing grant depend on this
  // line, and each also asks for the union explicitly on the request side —
  // `startChatConnect` from a `connectionId` a console screen supplies,
  // `startCalendarConnect` from the workspace's one unambiguous connection —
  // because neither defence is load-bearing alone.
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("scope", options.scopes.join(" "));
  url.searchParams.set("state", options.state);
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How a token call failed. Same taxonomy as `DropboxOAuthErrorCode`, renamed
 * to Google's vocabulary:
 *
 *  - `GRANT_REVOKED`     — `invalid_grant`. The code was spent or expired, or
 *                          the refresh token was revoked (the person removed
 *                          this app from their Google account, or changed
 *                          their password on an account with fewer than the
 *                          usual grace-period tokens). **Terminal. Reconnect.**
 *  - `REQUEST_REJECTED`  — Google understood and refused: wrong client id,
 *                          mismatched redirect, malformed request. Our bug or
 *                          our configuration.
 *  - `GOOGLE_UNAVAILABLE` — 5xx, 429, a deadline, or no answer at all. Retry.
 *  - `RESPONSE_UNUSABLE`  — a 2xx whose body is not the documented shape.
 */
export type GoogleOAuthErrorCode = "GRANT_REVOKED" | "REQUEST_REJECTED" | "GOOGLE_UNAVAILABLE" | "RESPONSE_UNUSABLE";

/** A Google OAuth failure, already classified. Carries no code, verifier, or token. */
export class GoogleOAuthError extends Error {
  readonly errorCode: GoogleOAuthErrorCode;
  readonly reconnectRequired: boolean;
  readonly providerErrorCode?: string;

  constructor(errorCode: GoogleOAuthErrorCode, message: string, providerErrorCode?: string) {
    super(message);
    this.name = "GoogleOAuthError";
    this.errorCode = errorCode;
    this.reconnectRequired = errorCode === "GRANT_REVOKED";
    if (providerErrorCode !== undefined) this.providerErrorCode = providerErrorCode;
  }
}

export function isGoogleReconnectRequired(error: unknown): boolean {
  return error instanceof GoogleOAuthError && error.reconnectRequired;
}

const PROVIDER_ERROR_SLUG = /^[a-z][a-z0-9_]{0,63}$/;

function classifyTokenFailure(status: number, slug: string | undefined): GoogleOAuthError {
  if (slug === "invalid_grant") {
    return new GoogleOAuthError(
      "GRANT_REVOKED",
      "Google no longer accepts this authorization. Reconnect to continue.",
      slug,
    );
  }
  if (status === 429 || status >= 500) {
    return new GoogleOAuthError("GOOGLE_UNAVAILABLE", "Google did not answer. Try again shortly.", slug);
  }
  return new GoogleOAuthError("REQUEST_REJECTED", "Google refused the request.", slug);
}

/* -------------------------------------------------------------------------- */
/* The token endpoint                                                         */
/* -------------------------------------------------------------------------- */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 15_000;

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
}

interface TokenResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  scope?: unknown;
  error?: unknown;
}

async function postToken(params: Record<string, string>, fetchImpl: FetchLike): Promise<TokenResponseBody> {
  const signal = timeoutSignal();
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(params).toString(),
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new GoogleOAuthError("GOOGLE_UNAVAILABLE", "Google could not be reached. Try again shortly.");
  }

  let body: TokenResponseBody = {};
  try {
    const raw = await response.text();
    body = raw.length === 0 ? {} : (JSON.parse(raw) as TokenResponseBody);
  } catch {
    body = {};
  }

  if (!response.ok) {
    const rawSlug = body.error;
    const slug = typeof rawSlug === "string" && PROVIDER_ERROR_SLUG.test(rawSlug) ? rawSlug : undefined;
    throw classifyTokenFailure(response.status, slug);
  }
  return body;
}

/** The furthest out we are willing to believe an access token lives. Google's are one hour. */
const MAX_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

function expiryFromSeconds(expiresIn: unknown, now: number): number {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) return now;
  return now + Math.min(expiresIn * 1000, MAX_TOKEN_LIFETIME_MS);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Decode the payload of a JWT without verifying its signature.
 *
 * See the module doc for why that is the right trust boundary here. Anything
 * that does not parse as three dot-separated base64url segments of JSON
 * returns `null` rather than throwing — a malformed id token is refused by
 * the caller the same way a response missing a documented field is.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = typeof atob === "function" ? atob(padded) : Buffer.from(padded, "base64").toString("binary");
    const bytes = Uint8Array.from(json, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** What a completed authorization gives us. Everything but the account identity is secret. */
export interface GoogleTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms, derived from `expires_in`. */
  expiresAt: number;
  /** The `sub` claim: Google's stable, opaque account id. Not a secret. */
  googleAccountId: string;
  /** The `email` claim. What the person knows this account as. */
  address: string;
  /** The scopes Google actually granted, verbatim — never assumed from what was requested. */
  scopes: string[];
}

/**
 * Spend an authorization code for a token set.
 *
 * A 200 missing any documented field is refused rather than partially
 * accepted — same reasoning as `exchangeDropboxCode`: a binding written from
 * half a response has no answer to "how do we refresh?" or "whose account is
 * this?", forever, and the person retrying a connect is cheap by comparison.
 */
export async function exchangeGoogleCode(options: {
  clientId: string;
  clientSecret?: string;
  code: string;
  verifier: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
}): Promise<GoogleTokenSet> {
  const body = await postToken(
    {
      grant_type: "authorization_code",
      code: options.code,
      code_verifier: options.verifier,
      client_id: options.clientId,
      redirect_uri: options.redirectUri,
      ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
    },
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
  );

  const accessToken = stringOrUndefined(body.access_token);
  const refreshToken = stringOrUndefined(body.refresh_token);
  const idToken = stringOrUndefined(body.id_token);
  const claims = idToken ? decodeJwtPayload(idToken) : null;
  const googleAccountId = stringOrUndefined(claims?.sub);
  const address = stringOrUndefined(claims?.email);

  if (
    accessToken === undefined ||
    refreshToken === undefined ||
    googleAccountId === undefined ||
    address === undefined
  ) {
    const missing = [
      accessToken === undefined ? "access_token" : null,
      refreshToken === undefined ? "refresh_token" : null,
      googleAccountId === undefined ? "id_token.sub" : null,
      address === undefined ? "id_token.email" : null,
    ]
      .filter((name): name is string => name !== null)
      .join(", ");
    throw new GoogleOAuthError("RESPONSE_UNUSABLE", `Google returned a token response with no ${missing}.`);
  }

  const grantedScopes =
    typeof body.scope === "string" && body.scope.length > 0 ? body.scope.split(/\s+/).filter(Boolean) : [];

  return {
    accessToken,
    refreshToken,
    expiresAt: expiryFromSeconds(body.expires_in, Date.now()),
    googleAccountId,
    address,
    scopes: grantedScopes,
  };
}

/** What a refresh gives us. Google does not rotate the refresh token on a normal refresh. */
export interface GoogleRefreshResult {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

export async function refreshGoogleToken(options: {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  fetchImpl?: FetchLike;
}): Promise<GoogleRefreshResult> {
  const body = await postToken(
    {
      grant_type: "refresh_token",
      refresh_token: options.refreshToken,
      client_id: options.clientId,
      ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
    },
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
  );

  const accessToken = stringOrUndefined(body.access_token);
  if (accessToken === undefined) {
    throw new GoogleOAuthError("RESPONSE_UNUSABLE", "Google returned a refresh response with no access_token.");
  }
  return { accessToken, expiresAt: expiryFromSeconds(body.expires_in, Date.now()) };
}

/**
 * Disable the grant behind a token. Google's revoke endpoint accepts either
 * an access or a refresh token and revokes the whole grant either way — every
 * product this account connected — so revoking the refresh token — the one
 * we hold long-term — is what disconnect uses; there is no "revoke just the
 * Gmail half" option to reach for, because it is one grant.
 */
export async function revokeGoogleToken(options: { token: string; fetchImpl?: FetchLike }): Promise<void> {
  const fetchImpl = options.fetchImpl ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));
  const signal = timeoutSignal();
  const response = await fetchImpl(GOOGLE_REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: options.token }).toString(),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    // Google answers an already-dead token with a 400 `invalid_token`, which
    // is the outcome revocation wanted; only a live-but-refused grant is
    // worth reporting.
    if (response.status === 400) return;
    throw new GoogleOAuthError("REQUEST_REJECTED", `Google refused the revoke call with status ${response.status}.`);
  }
}
