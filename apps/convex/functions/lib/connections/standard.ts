/**
 * The action-side half of a standard OAuth connector (every provider but
 * Slack): which client starts the consent, registered with the app on first
 * use for an MCP server (`../providers/mcpOAuth.ts`), the resource and scopes
 * a token is asked for, and the exchange. Registers no function of its own;
 * only internal actions call it, since it can open a sealed client secret.
 */

import type { ActionCtx } from "../../../_generated/server";
import { decryptSecret, requireKeyset } from "../crypto";
import { resolveClientInfo } from "./standardClient";
import { exchangeCode } from "../providers/oauth";
import type { ExchangedToken, OAuthClient, StandardSpec } from "../providers/types";

const PLATFORM = { platform: "integration" } as const;

export { resourceFor, scopesFor } from "./standardClient";
import { resourceFor } from "./standardClient";

/** The client with its secret opened, for an exchange, a refresh or a revoke. */
export async function resolveClient(
  ctx: ActionCtx,
  spec: StandardSpec,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthClient | null> {
  const found = await resolveClientInfo(ctx, spec, redirectUri, fetchImpl);
  if (found === null) return null;
  const { encryptedClientSecret, client } = found;
  if (encryptedClientSecret === undefined) return client;
  return { ...client, clientSecret: await decryptSecret(encryptedClientSecret, requireKeyset(), PLATFORM) };
}

/**
 * Swap a consent's code for tokens, and learn who they act as: an API of
 * ours asks the provider; an MCP server names nobody, so the app itself is
 * the one account a person connects there.
 */
export async function exchangeStandard(
  spec: StandardSpec,
  client: OAuthClient,
  options: { code: string; redirectUri: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangedToken | null> {
  const tokens = await exchangeCode(client, { ...options, resource: resourceFor(spec, client) }, fetchImpl);
  if (tokens === null) return null;
  const identity = spec.kind === "tools" ? await spec.identify(tokens.accessToken) : { accountId: spec.id, teamId: spec.id, teamName: spec.name };
  if (identity === null) return null;
  return { ...tokens, ...identity };
}
