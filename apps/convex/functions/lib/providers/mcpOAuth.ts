/**
 * How an official MCP server is connected: its authorization server is found
 * from the server's own metadata (RFC 9728, then RFC 8414 or OpenID
 * discovery), and Context registers itself there as a client (RFC 7591), once
 * per deployment, the way the MCP authorization spec expects a client it has
 * never met to do. Nothing here is provider-specific; the server's address is
 * the registry's.
 *
 * Every address found must be https, so metadata cannot point a consent or
 * an exchange at plain http.
 */

import type { OAuthEndpoints } from "./types";

type Fetch = typeof fetch;

export type DiscoveredAuth = OAuthEndpoints & {
  registrationEndpoint?: string;
  /** The resource a token is minted for (RFC 8707), as the server names itself. */
  resource?: string;
  /** The scopes the server itself says it takes; asked for when the registry names none. */
  scopesSupported?: string[];
};

/** The name a person sees on the app's consent screen. */
export const REGISTERED_CLIENT_NAME = "Tex by Context";

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function getJson(url: string, fetchImpl: Fetch): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" }, redirect: "follow" });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `/.well-known/<name>` for an issuer or resource, path appended as RFC 8414 §3.1 and RFC 9728 §3.1 say, then without it. */
function wellKnown(base: string, name: string): string[] {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  const candidates = [`${url.origin}/.well-known/${name}${path}`];
  if (path !== "") candidates.push(`${url.origin}/.well-known/${name}`);
  return candidates;
}

async function firstJson(urls: string[], fetchImpl: Fetch): Promise<Record<string, unknown> | null> {
  for (const url of urls) {
    const body = await getJson(url, fetchImpl);
    if (body !== null) return body;
  }
  return null;
}

/** The server's authorization endpoints, or null where it publishes none we can use. */
export async function discoverMcpAuth(serverUrl: string, fetchImpl: Fetch = fetch): Promise<DiscoveredAuth | null> {
  const resource = await firstJson(wellKnown(serverUrl, "oauth-protected-resource"), fetchImpl);
  const servers = Array.isArray(resource?.authorization_servers) ? resource.authorization_servers : [];
  const issuer = httpsUrl(servers[0]) ?? new URL(serverUrl).origin;
  const issuerPath = new URL(issuer).pathname.replace(/\/+$/, "");
  const metadata = await firstJson(
    [
      ...wellKnown(issuer, "oauth-authorization-server"),
      ...wellKnown(issuer, "openid-configuration"),
      ...(issuerPath === "" ? [] : [`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`]),
    ],
    fetchImpl,
  );
  if (metadata === null) return null;
  const authorizationEndpoint = httpsUrl(metadata.authorization_endpoint);
  const tokenEndpoint = httpsUrl(metadata.token_endpoint);
  if (authorizationEndpoint === null || tokenEndpoint === null) return null;
  const methods = metadata.code_challenge_methods_supported;
  // PKCE with S256 is required; a server that says it supports other methods only is not one we connect.
  if (Array.isArray(methods) && !methods.includes("S256")) return null;
  const registrationEndpoint = httpsUrl(metadata.registration_endpoint);
  const revocationEndpoint = httpsUrl(metadata.revocation_endpoint);
  // The resource's own list, not the authorization server's: that one covers every product it signs in to.
  const scopes = Array.isArray(resource?.scopes_supported) ? resource.scopes_supported : undefined;
  const resourceId = httpsUrl(resource?.resource);
  return {
    ...(resourceId === null ? {} : { resource: resourceId }),
    authorizationEndpoint,
    tokenEndpoint,
    ...(revocationEndpoint === null ? {} : { revocationEndpoint }),
    ...(registrationEndpoint === null ? {} : { registrationEndpoint }),
    ...(scopes === undefined ? {} : { scopesSupported: scopes.filter((s): s is string => typeof s === "string") }),
  };
}

/** Register Context as a client of the server's authorization server; null if it refuses. */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchImpl: Fetch = fetch,
): Promise<{ clientId: string; clientSecret?: string } | null> {
  try {
    const response = await fetchImpl(registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: REGISTERED_CLIENT_NAME,
        client_uri: "https://context.lc",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      redirect: "manual",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const clientId = typeof body.client_id === "string" && body.client_id !== "" ? body.client_id : null;
    if (clientId === null) return null;
    const clientSecret = typeof body.client_secret === "string" && body.client_secret !== "" ? body.client_secret : undefined;
    return { clientId, ...(clientSecret === undefined ? {} : { clientSecret }) };
  } catch {
    return null;
  }
}
