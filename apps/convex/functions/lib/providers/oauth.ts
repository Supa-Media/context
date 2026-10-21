/**
 * Standard OAuth 2 for connectors (RFC 6749 with PKCE, RFC 7636): the consent
 * address, the code exchange, a refresh and a revoke, for every provider that
 * is not Slack (`types.ts` `StandardSpec`). An MCP server's endpoints and
 * client come from `mcpOAuth.ts`; the rest name theirs in the registry.
 *
 * `resource` is RFC 8707's resource indicator, which the MCP authorization
 * spec requires on both the consent and the exchange so a token is minted for
 * that one server.
 */

import type { OAuthClient } from "./types";

export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresInMs?: number;
  scopes: string[];
};

type Fetch = typeof fetch;

export function standardAuthorizeUrl(
  client: OAuthClient,
  options: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scopes: readonly string[];
    resource?: string;
    extra?: Record<string, string>;
  },
): string {
  const url = new URL(client.endpoints.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (options.scopes.length > 0) url.searchParams.set("scope", options.scopes.join(" "));
  if (options.resource !== undefined) url.searchParams.set("resource", options.resource);
  for (const [key, value] of Object.entries(options.extra ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A token endpoint's answer, or null for an error or anything without an access token. */
export function readTokenAnswer(body: unknown): TokenSet | null {
  if (body === null || typeof body !== "object") return null;
  const answer = body as Record<string, unknown>;
  const accessToken = text(answer.access_token);
  if (accessToken === null) return null;
  const tokenType = text(answer.token_type);
  if (tokenType !== null && tokenType.toLowerCase() !== "bearer") return null;
  const expiresIn = typeof answer.expires_in === "number" ? answer.expires_in : Number(answer.expires_in);
  const refreshToken = text(answer.refresh_token);
  return {
    accessToken,
    ...(refreshToken === null ? {} : { refreshToken }),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresInMs: expiresIn * 1000 } : {}),
    scopes: (text(answer.scope) ?? "").split(/[ ,]+/).filter(Boolean),
  };
}

async function tokenRequest(client: OAuthClient, form: Record<string, string>, fetchImpl: Fetch): Promise<TokenSet | null> {
  const body = new URLSearchParams({ ...form, client_id: client.clientId });
  // client_secret_post: every provider here takes it, and a registered public client has none.
  if (client.clientSecret !== undefined) body.set("client_secret", client.clientSecret);
  const response = await fetchImpl(client.endpoints.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    redirect: "manual",
  });
  if (!response.ok) return null;
  try {
    return readTokenAnswer(await response.json());
  } catch {
    return null;
  }
}

export async function exchangeCode(
  client: OAuthClient,
  options: { code: string; redirectUri: string; codeVerifier: string; resource?: string },
  fetchImpl: Fetch = fetch,
): Promise<TokenSet | null> {
  return await tokenRequest(
    client,
    {
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
      code_verifier: options.codeVerifier,
      ...(options.resource === undefined ? {} : { resource: options.resource }),
    },
    fetchImpl,
  );
}

/** A new access token for a refresh token; a provider that rotates them answers a new one too. */
export async function refreshTokens(
  client: OAuthClient,
  options: { refreshToken: string; resource?: string },
  fetchImpl: Fetch = fetch,
): Promise<TokenSet | null> {
  return await tokenRequest(
    client,
    {
      grant_type: "refresh_token",
      refresh_token: options.refreshToken,
      ...(options.resource === undefined ? {} : { resource: options.resource }),
    },
    fetchImpl,
  );
}

/** RFC 7009, best effort: a provider with no revocation endpoint is left to its own settings page. */
export async function revokeAtProvider(client: OAuthClient, token: string, fetchImpl: Fetch = fetch): Promise<void> {
  const endpoint = client.endpoints.revocationEndpoint;
  if (endpoint === undefined) return;
  const body = new URLSearchParams({ token, client_id: client.clientId });
  if (client.clientSecret !== undefined) body.set("client_secret", client.clientSecret);
  await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
}
