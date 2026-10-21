/**
 * Which OAuth client a standard provider's consent starts with, without
 * opening any secret: the deployment's own (its id from a variable), or the
 * one Context registered with an MCP server's authorization server
 * (`../providers/mcpOAuth.ts`), registering it on first use. A public action
 * starts a consent with this; only `standard.ts`, called from internal
 * functions, opens a client secret (`__tests__/structure/reachability.test.ts`).
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { encryptSecret, requireKeyset } from "../crypto";
import { discoverMcpAuth, registerClient } from "../providers/mcpOAuth";
import type { OAuthClient, StandardSpec } from "../providers/types";

const PLATFORM = { platform: "integration" } as const;

/** RFC 8707's resource for an MCP server's token, as the server named itself; none for an API of ours. */
export function resourceFor(spec: StandardSpec, client: OAuthClient): string | undefined {
  return spec.kind === "mcp" ? (client.resource ?? spec.serverUrl) : undefined;
}

/** The registry's scopes, or the ones the MCP server says it takes. */
export function scopesFor(spec: StandardSpec, client: OAuthClient): readonly string[] {
  return spec.scopes.length > 0 ? spec.scopes : (client.scopes ?? []);
}

/**
 * The client, its secret still sealed (`encryptedClientSecret`), or null
 * where the provider has none on this deployment. An env client's secret is
 * a variable, never sealed, and is read only where it is spent.
 */
export async function resolveClientInfo(
  ctx: ActionCtx,
  spec: StandardSpec,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ client: OAuthClient; encryptedClientSecret?: string } | null> {
  if (spec.client.kind === "env") {
    const clientId = process.env[spec.client.idEnvVar];
    const clientSecret = process.env[spec.client.secretEnvVar];
    if (!clientId || !clientSecret) return null;
    return { client: { clientId, clientSecret, endpoints: spec.client.endpoints } };
  }
  if (spec.kind !== "mcp") return null;
  const saved = await ctx.runQuery(internal.functions.connectionClients.registeredClient, { provider: spec.id, redirectUri });
  if (saved !== null) {
    const { encryptedClientSecret, authorizationEndpoint, tokenEndpoint, revocationEndpoint, ...rest } = saved;
    return {
      client: { ...rest, endpoints: { authorizationEndpoint, tokenEndpoint, ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }) } },
      ...(encryptedClientSecret === undefined ? {} : { encryptedClientSecret }),
    };
  }
  const discovered = await discoverMcpAuth(spec.serverUrl, fetchImpl);
  if (discovered?.registrationEndpoint === undefined) return null;
  const registered = await registerClient(discovered.registrationEndpoint, redirectUri, fetchImpl);
  if (registered === null) return null;
  const endpoints = {
    authorizationEndpoint: discovered.authorizationEndpoint,
    tokenEndpoint: discovered.tokenEndpoint,
    ...(discovered.revocationEndpoint === undefined ? {} : { revocationEndpoint: discovered.revocationEndpoint }),
  };
  const described = {
    ...(discovered.resource === undefined ? {} : { resource: discovered.resource }),
    ...(discovered.scopesSupported === undefined ? {} : { scopes: discovered.scopesSupported }),
  };
  // Two first connects at once both register; the first saved wins and both use it.
  const kept = await ctx.runMutation(internal.functions.connectionClients.saveRegisteredClient, {
    provider: spec.id,
    redirectUri,
    clientId: registered.clientId,
    ...(registered.clientSecret === undefined
      ? {}
      : { encryptedClientSecret: await encryptSecret(registered.clientSecret, requireKeyset(), PLATFORM) }),
    ...endpoints,
    ...described,
  });
  if (kept.clientId !== registered.clientId) return await resolveClientInfo(ctx, spec, redirectUri, fetchImpl);
  return { client: { clientId: registered.clientId, endpoints, ...described } };
}
