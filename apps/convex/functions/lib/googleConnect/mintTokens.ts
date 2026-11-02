/**
 * A short-lived Google access token for one connection, in one role
 * (`functions/googleClients.ts`). Opens the role's refresh token; reached only
 * from `googleConnect.mintGoogleAccessToken(Outcome)`, which are internal
 * (this file is on the decrypt allowlist in
 * `__tests__/structure/fixtures.helpers.ts`).
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { decryptSecret, encryptSecret, requireKeyset } from "../crypto";
import { GoogleOAuthError, isGoogleReconnectRequired, refreshGoogleToken } from "../googleOAuth";
import { agentClientActive, googleClientFor, googleEnvForRow, grantFor, type GoogleClientRole } from "./clients";
import type { MintOutcome } from "./syncTokens";

type ConnectionTokens = {
  workspaceId: Id<"workspaces">;
  encryptedRefreshToken: string;
  encryptedAccessToken?: string;
  accessTokenExpiresAt?: number;
  disconnectedAt?: number;
  consentPlan?: "split";
  agentGrant?: { encryptedRefreshToken: string; encryptedAccessToken?: string; accessTokenExpiresAt?: number };
};

/**
 * A short-lived access token for one connection, in one role. Called by
 * `googleConnect.mintGoogleAccessToken(Outcome)`, which are internal.
 */
export async function mintAccessToken(
  ctx: ActionCtx,
  connectionId: Id<"googleConnections">,
  forceRefresh: boolean,
  role: GoogleClientRole,
): Promise<MintOutcome> {
  const connection: ConnectionTokens | null = await ctx.runQuery(internal.functions.googleConnect.getConnectionForSync, { connectionId });
  if (connection === null || connection.disconnectedAt !== undefined) return { kind: "refused" };
  const env = googleEnvForRow({ workspaceId: connection.workspaceId as string, consentPlan: connection.consentPlan });
  const grant = grantFor(role, connection.agentGrant !== undefined, env);
  // Once switched on, an agent call takes the agent grant or nothing.
  const tokens = grant === "agent" ? connection.agentGrant : connection;
  if (tokens === undefined || tokens.encryptedRefreshToken.length === 0) return { kind: "refused" };

  const keyset = requireKeyset();
  const context = { workspaceId: connection.workspaceId as string };
  // A cached token good for another minute is reused, as `storage.ts` does.
  if (!forceRefresh && tokens.encryptedAccessToken && tokens.accessTokenExpiresAt && tokens.accessTokenExpiresAt > Date.now() + 60_000) {
    return {
      kind: "minted",
      accessToken: await decryptSecret(tokens.encryptedAccessToken, keyset, context),
      expiresAt: tokens.accessTokenExpiresAt,
    };
  }

  const client = googleClientFor(grant);
  if (client === null) return { kind: "refused" };
  const refreshToken = await decryptSecret(tokens.encryptedRefreshToken, keyset, context);
  let refreshed;
  try {
    refreshed = await refreshGoogleToken({ ...client, refreshToken });
  } catch (error) {
    // Only `invalid_grant` is the person's to fix. A 5xx, a 429, a timeout or
    // a garbled answer is Google's, and lifts by itself. A refused agent grant
    // is dropped, so the app asks for AI access again; it never marks the
    // person's own connection as needing a reconnect.
    if (isGoogleReconnectRequired(error)) {
      if (grant === "agent") {
        await ctx.runMutation(internal.functions.googleClients.dropAgentGrant, { connectionId });
        // Before the switch, the account goes back to the one grant everyone else reads through.
        if (!agentClientActive(env)) return await mintAccessToken(ctx, connectionId, forceRefresh, role);
        return { kind: "refused" };
      }
      await ctx.runMutation(internal.functions.googleConnect.markReconnectRequired, { connectionId });
      return { kind: "reconnect_required" };
    }
    if (error instanceof GoogleOAuthError && (error.errorCode === "GOOGLE_UNAVAILABLE" || error.errorCode === "RESPONSE_UNUSABLE")) {
      return { kind: "unavailable" };
    }
    return { kind: "refused" };
  }

  const encryptedAccessToken = await encryptSecret(refreshed.accessToken, keyset, context);
  if (grant === "agent") {
    await ctx.runMutation(internal.functions.googleClients.cacheAgentAccessToken, {
      connectionId,
      encryptedAccessToken,
      accessTokenExpiresAt: refreshed.expiresAt,
    });
  } else {
    // Caching it also clears a `reconnect_required` the refresh just disproved.
    await ctx.runMutation(internal.functions.googleConnect.cacheAccessToken, {
      connectionId,
      encryptedAccessToken,
      accessTokenExpiresAt: refreshed.expiresAt,
    });
  }
  return { kind: "minted", accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
}
