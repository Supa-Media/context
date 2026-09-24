import { sha256Hex } from "../controlPlane.js";
import { SUPPORTED_SCOPES } from "../session.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_REQUESTED_SCOPE,
  REGISTRATION_BYTE_CAP,
} from "./policy.js";
import { base64Url, jsonResponse, oauthError, randomToken } from "./responses.js";
import { resourceMatches } from "./discovery.js";

/* --------------------------------- token ---------------------------------- */

/**
 * Verify a PKCE code verifier against the stored S256 challenge.
 *
 * Constant-time comparison of the two base64url digests. The comparison is on
 * hashes of equal length, so the early length exit leaks nothing.
 */
async function verifyPkce(codeVerifier, codeChallenge) {
  if (typeof codeVerifier !== "string") return false;
  // RFC 7636 §4.1 — 43 to 128 characters from the unreserved set.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const computed = base64Url(new Uint8Array(digest));
  if (computed.length !== codeChallenge.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i += 1) {
    diff |= computed.charCodeAt(i) ^ codeChallenge.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Read a token-endpoint request body.
 *
 * `application/x-www-form-urlencoded` is mandatory per RFC 6749 §4.1.3, and
 * Anthropic calls out that a JSON-only token endpoint returns 415 and breaks
 * the flow outright. Note the asymmetry with `/oauth/register`, which is JSON:
 * two endpoints, two parsers, on purpose.
 */
export async function readForm(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/x-www-form-urlencoded")) return null;
  const raw = await request.text();
  if (raw.length > REGISTRATION_BYTE_CAP) return null;
  return new URLSearchParams(raw);
}

/**
 * Authenticate the client presenting a token request.
 *
 * Public clients (`token_endpoint_auth_method: "none"`) present only their
 * `client_id`; PKCE, not a secret, is what binds the exchange to them.
 * Confidential clients must present the secret they were issued, compared as a
 * hash so the stored value is never a working credential.
 */
export async function authenticateClient(client, params, request) {
  if (client.tokenEndpointAuthMethod === "none" || client.hashedClientSecret === null) {
    return true;
  }
  let presented = params.get("client_secret");
  if (!presented) {
    // RFC 6749 §2.3.1 also allows HTTP Basic. Accepted because some clients
    // send it despite registering `client_secret_post`.
    const header = request.headers.get("Authorization") || "";
    if (/^Basic /i.test(header)) {
      try {
        const decoded = atob(header.slice(6).trim());
        presented = decoded.slice(decoded.indexOf(":") + 1);
      } catch {
        presented = null;
      }
    }
  }
  if (!presented) return false;
  const hashed = await sha256Hex(presented);
  if (hashed.length !== client.hashedClientSecret.length) return false;
  let diff = 0;
  for (let i = 0; i < hashed.length; i += 1) {
    diff |= hashed.charCodeAt(i) ^ client.hashedClientSecret.charCodeAt(i);
  }
  return diff === 0;
}

export async function handleToken(request, env, controlPlane, { origin, slug }) {
  const params = await readForm(request);
  if (!params) {
    return oauthError(
      "invalid_request",
      "The token endpoint requires application/x-www-form-urlencoded."
    );
  }

  const clientId = params.get("client_id");
  if (!clientId) return oauthError("invalid_client", "client_id is required.", 401);
  const client = await controlPlane.getClient(clientId);
  if (!client) return oauthError("invalid_client", "Unknown client.", 401);
  if (!(await authenticateClient(client, params, request))) {
    return oauthError("invalid_client", "Client authentication failed.", 401);
  }

  const resource = params.get("resource");
  if (resource && !resourceMatches(resource, origin, slug)) {
    return oauthError("invalid_target", "resource does not identify this MCP server.");
  }

  const grantType = params.get("grant_type");
  if (grantType === "authorization_code") {
    return exchangeCode(params, client, controlPlane);
  }
  if (grantType === "refresh_token") {
    return refresh(params, client, controlPlane);
  }
  return oauthError("unsupported_grant_type", "Unsupported grant_type.");
}

async function exchangeCode(params, client, controlPlane) {
  const code = params.get("code");
  const redirectUri = params.get("redirect_uri");
  const codeVerifier = params.get("code_verifier");
  if (!code) return oauthError("invalid_request", "code is required.");
  if (!redirectUri) return oauthError("invalid_request", "redirect_uri is required.");
  if (!codeVerifier) return oauthError("invalid_request", "code_verifier is required.");

  // Spent first, checked second. A code that fails any check below is already
  // dead, which is what RFC 6749 §4.1.2 asks for: a code presented wrongly is a
  // code that may have leaked, and a retryable one is a code an attacker gets
  // to keep guessing against. `consumeAuthorizationCode` is atomic, so a replay
  // — even a concurrent one — gets `null` here and cannot be distinguished from
  // a code that never existed.
  const authorization = await controlPlane.consumeAuthorizationCode(code, client.clientId);
  if (!authorization) return oauthError("invalid_grant", "The authorization code is invalid.");

  if (authorization.clientId !== client.clientId) {
    return oauthError("invalid_grant", "The authorization code is invalid.");
  }
  // Exact match against the value stored at authorization time, not against the
  // client's registered list: RFC 6749 §4.1.3 binds the code to the specific
  // URI the flow started with, so a client with two registered URIs cannot
  // complete a flow started at one by presenting the other.
  if (authorization.redirectUri !== redirectUri) {
    return oauthError("invalid_grant", "redirect_uri does not match the authorization request.");
  }
  if (authorization.codeChallengeMethod !== "S256") {
    return oauthError("invalid_grant", "The authorization code is invalid.");
  }
  if (!(await verifyPkce(codeVerifier, authorization.codeChallenge))) {
    return oauthError("invalid_grant", "The code_verifier does not match the code_challenge.");
  }

  // `authorization.scope` is what the *person approved*, not what the client
  // asked for — the control plane narrowed it at consent time and clamped it to
  // what the approver's role could hand over. Filtering against
  // `SUPPORTED_SCOPES` here drops anything this gateway would not honour
  // anyway; it is a sanity pass, not the narrowing.
  const scopes = (authorization.scope || DEFAULT_REQUESTED_SCOPE)
    .split(/\s+/)
    .filter((entry) => SUPPORTED_SCOPES.includes(entry));
  if (!scopes.length) return oauthError("invalid_scope", "No usable scope was granted.");

  const accessToken = `cat_${randomToken(32)}`;
  const refreshToken = `crt_${randomToken(32)}`;
  const expiresAt = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;

  await controlPlane.createGrant({
    workspaceId: authorization.workspaceId,
    userId: authorization.userId,
    clientId: client.clientId,
    scopes,
    hashedRefreshToken: await sha256Hex(refreshToken),
    hashedAccessToken: await sha256Hex(accessToken),
    accessTokenExpiresAt: expiresAt,
  });

  return tokenResponse(accessToken, refreshToken, scopes);
}

async function refresh(params, client, controlPlane) {
  const presented = params.get("refresh_token");
  if (!presented) return oauthError("invalid_request", "refresh_token is required.");

  const accessToken = `cat_${randomToken(32)}`;
  const refreshToken = `crt_${randomToken(32)}`;
  const expiresAt = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;

  const requestedScope = params.get("scope");
  const narrowed = requestedScope
    ? requestedScope.split(/\s+/).filter((entry) => SUPPORTED_SCOPES.includes(entry))
    : null;

  // Rotation is mandatory for public clients under OAuth 2.1 §4.3.1, so the old
  // refresh token dies in the same transaction that mints the new one. The
  // control plane detects reuse of an already-rotated token and revokes the
  // whole grant — a replayed refresh token means it leaked, and leaving the
  // grant alive leaves the thief alive with it.
  const grant = await controlPlane.rotateGrant({
    // Verbatim, so the stored hash is not itself a working credential; the
    // *new* pair goes over as hashes, because only the client needs the
    // plaintext. See the rule in controlPlane.js.
    refreshToken: presented,
    clientId: client.clientId,
    newHashedRefreshToken: await sha256Hex(refreshToken),
    newHashedAccessToken: await sha256Hex(accessToken),
    accessTokenExpiresAt: expiresAt,
    scopes: narrowed && narrowed.length ? narrowed : null,
  });

  // `invalid_grant` specifically. Anthropic's client treats anything else —
  // `invalid_request`, a custom code — as a hard failure rather than a signal
  // to re-authorize, and the connection silently stops refreshing.
  if (!grant) return oauthError("invalid_grant", "The refresh token is invalid or revoked.");

  return tokenResponse(accessToken, refreshToken, grant.scopes || []);
}

function tokenResponse(accessToken, refreshToken, scopes) {
  return jsonResponse({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  });
}
