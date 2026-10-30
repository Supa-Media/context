/**
 * Two Google OAuth clients for one Context app: a standard one, and an agent
 * one (CASA round 2, 2026-10-28; docs/decisions/communications/google-clients.md).
 *
 * Google asks that AI and automated access to a person's Google data go
 * through a client registered as such, and that a person's own direct use of
 * an app stay on a standard client. So each Google connection can hold two
 * grants for the same account, and every place that mints an access token
 * says which role it is acting in:
 *
 *  - `standard`: the person in the app reading their own calendar (the
 *    Meetings view). The connection's top-level token fields.
 *  - `agent`: Tex, AI clients through the gateway, routines, and sync whose
 *    output is written into notes for AI to read. `googleConnections.agentGrant`.
 *
 * Staged. Once the agent client is configured, a person may allow AI access
 * through a second consent on the same `/connect/google` callback, bound to
 * the connection by a parked attempt (state, PKCE, completion secret) like
 * every connect, and from then AI reads that account through the agent
 * grant: a per-account rollout before anything is switched on. Everyone
 * else's AI keeps reading through the standard grant, today's behaviour,
 * until `GOOGLE_AGENT_CLIENT_ACTIVE` is `true`. From then the agent role
 * mints from `agentGrant` ONLY, and fails closed without one, or without a
 * configured agent client. There is no fallback to the standard grant after
 * the switch.
 *
 * Nothing here revokes a grant at Google except an explicit disconnect.
 * Google's revoke ends the account's grants to the whole project, every
 * client, so revoking a replaced agent token, or a consent from the wrong
 * account, would also end the grants it was meant to keep.
 *
 * This module opens refresh tokens (it is on the decrypt allowlist in
 * `__tests__/structure/fixtures.helpers.ts`); everything that does is
 * internal, and the one public action here encrypts a verifier and returns
 * an authorize URL, as `startGoogleConnect` does.
 */

import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { decryptSecret, encryptSecret, hashToken, requireKeyset } from "./lib/crypto";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import {
  createPkcePair,
  exchangeGoogleCode,
  googleAuthorizeUrl,
  googleRedirectAllowed,
  GoogleOAuthError,
  revokeGoogleToken,
} from "./lib/googleOAuth";
import { agentScopesFor } from "./lib/googleConnect/aiScopes";
import { googleClientFor, googleEnvFor } from "./lib/googleConnect/clients";
import { ATTEMPT_TTL_MS, requireActor, STATE_BYTES } from "./lib/googleConnect/config";


export const cacheAgentAccessToken = internalMutation({
  args: { connectionId: v.id("googleConnections"), encryptedAccessToken: v.string(), accessTokenExpiresAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (connection === null || connection.disconnectedAt !== undefined || connection.agentGrant === undefined) return null;
    await ctx.db.patch(args.connectionId, {
      agentGrant: { ...connection.agentGrant, encryptedAccessToken: args.encryptedAccessToken, accessTokenExpiresAt: args.accessTokenExpiresAt },
    });
    return null;
  },
});

/** Google refused the agent grant: forget it, so the app asks again. */
export const dropAgentGrant = internalMutation({
  args: { connectionId: v.id("googleConnections") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (connection === null || connection.agentGrant === undefined) return null;
    await ctx.db.patch(args.connectionId, { agentGrant: undefined });
    console.log(JSON.stringify({ event: "google.agent_grant_dropped", connectionId: args.connectionId }));
    return null;
  },
});

/* ------------------------- allowing AI access ------------------------- */

/**
 * Start the agent client's consent for one of the person's connections. The
 * same scopes the connection was given, the same `/connect/google` callback,
 * pinned to the app's origin; refused only while no agent client is
 * configured, so it can be proven on real accounts before the switch.
 */
export const startGoogleAgentConnect = action({
  args: { workspaceId: v.id("workspaces"), connectionId: v.id("googleConnections"), redirectUri: v.string() },
  returns: v.object({ authorizeUrl: v.string(), completionSecret: v.string() }),
  handler: async (ctx, args): Promise<{ authorizeUrl: string; completionSecret: string }> => {
    const client = googleClientFor("agent");
    if (client === null) {
      throw new ConvexError({ code: "AGENT_CLIENT_NOT_CONFIGURED", message: "AI access to Google is not set up on this deployment." });
    }
    const userId = await requireActor(ctx);
    const target: { address: string; products: Array<"gmail" | "calendar" | "chat"> } | null = await ctx.runQuery(
      internal.functions.googleClientsAccess.agentConnectTarget,
      { workspaceId: args.workspaceId, connectionId: args.connectionId, userId },
    );
    if (target === null) throw new ConvexError({ code: "NOT_FOUND", message: "That connection was not found." });
    if (!googleRedirectAllowed(args.redirectUri)) {
      throw new ConvexError({ code: "REDIRECT_URI_NOT_ALLOWED", message: "That redirect URI is not one this deployment answers on." });
    }

    const { verifier, challenge } = await createPkcePair();
    const state = randomOpaqueToken(STATE_BYTES);
    const completionSecret = randomOpaqueToken(STATE_BYTES);
    await ctx.runMutation(internal.functions.googleClients.parkAgentAttempt, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(completionSecret),
      encryptedVerifier: await encryptSecret(verifier, requireKeyset(), { workspaceId: args.workspaceId as string }),
      workspaceId: args.workspaceId,
      connectionId: args.connectionId,
      startedBy: userId,
      redirectUri: args.redirectUri,
    });
    return {
      completionSecret,
      authorizeUrl: googleAuthorizeUrl({
        clientId: client.clientId,
        redirectUri: args.redirectUri,
        challenge,
        state,
        scopes: agentScopesFor(target.products, googleEnvFor(args.workspaceId)),
        loginHint: target.address,
      }),
    };
  },
});

const parkedAttempt = {
  hashedState: v.string(),
  hashedCompletion: v.string(),
  encryptedVerifier: v.string(),
  workspaceId: v.id("workspaces"),
  connectionId: v.id("googleConnections"),
  startedBy: v.id("users"),
  redirectUri: v.string(),
};

export const parkAgentAttempt = internalMutation({
  args: parkedAttempt,
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("googleAgentAttempts", { ...args, expiresAt: Date.now() + ATTEMPT_TTL_MS });
    await ctx.scheduler.runAfter(ATTEMPT_TTL_MS, internal.functions.googleClients.forgetAgentAttempt, { id });
    return null;
  },
});

export const forgetAgentAttempt = internalMutation({
  args: { id: v.id("googleAgentAttempts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    if ((await ctx.db.get(args.id)) !== null) await ctx.db.delete(args.id);
    return null;
  },
});

/**
 * Spend an agent attempt from the shared callback (`completeGoogleConnect`
 * asks here first). Null for a state that is not one: the callback then tries
 * the ordinary connect. Deleted before use; a wrong completion secret or an
 * expired attempt spends it and answers the ordinary refusal.
 */
export const consumeAgentAttempt = internalMutation({
  args: { hashedState: v.string(), code: v.string(), hashedCompletion: v.string() },
  returns: v.union(v.null(), v.object({ workspaceId: v.id("workspaces"), spent: v.boolean() })),
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("googleAgentAttempts")
      .withIndex("by_hashed_state", (q) => q.eq("hashedState", args.hashedState))
      .unique();
    if (attempt === null) return null;
    await ctx.db.delete(attempt._id);
    if (attempt.expiresAt < Date.now() || attempt.hashedCompletion !== args.hashedCompletion) {
      return { workspaceId: attempt.workspaceId, spent: false };
    }
    await ctx.scheduler.runAfter(0, internal.functions.googleClients.exchangeAndBindAgent, {
      workspaceId: attempt.workspaceId,
      connectionId: attempt.connectionId,
      encryptedVerifier: attempt.encryptedVerifier,
      code: args.code,
      redirectUri: attempt.redirectUri,
    });
    return { workspaceId: attempt.workspaceId, spent: true };
  },
});

export const exchangeAndBindAgent = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    connectionId: v.id("googleConnections"),
    encryptedVerifier: v.string(),
    code: v.string(),
    redirectUri: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const client = googleClientFor("agent");
    if (client === null) return null;
    const keyset = requireKeyset();
    const context = { workspaceId: args.workspaceId as string };
    const verifier = await decryptSecret(args.encryptedVerifier, keyset, context);
    let tokens;
    try {
      tokens = await exchangeGoogleCode({ ...client, code: args.code, verifier, redirectUri: args.redirectUri });
    } catch (error) {
      const code = error instanceof GoogleOAuthError ? error.errorCode : "UNEXPECTED";
      console.log(JSON.stringify({ event: "google.agent_connect_failed", connectionId: args.connectionId, errorCode: code }));
      return null;
    }
    const bound: boolean = await ctx.runMutation(internal.functions.googleClients.applyAgentGrant, {
      connectionId: args.connectionId,
      workspaceId: args.workspaceId,
      googleAccountId: tokens.googleAccountId,
      scopes: tokens.scopes,
      encryptedRefreshToken: await encryptSecret(tokens.refreshToken, keyset, context),
      encryptedAccessToken: await encryptSecret(tokens.accessToken, keyset, context),
      accessTokenExpiresAt: tokens.expiresAt,
    });
    // A consent from a different Google account than the connection's binds
    // nothing, and its tokens are discarded here. Not revoked: Google's revoke
    // would end that account's grants to every client of this project,
    // including any connection it already has in Context.
    console.log(JSON.stringify({ event: bound ? "google.agent_grant_bound" : "google.agent_grant_refused", connectionId: args.connectionId }));
    return null;
  },
});

export const applyAgentGrant = internalMutation({
  args: {
    connectionId: v.id("googleConnections"),
    workspaceId: v.id("workspaces"),
    googleAccountId: v.string(),
    scopes: v.array(v.string()),
    encryptedRefreshToken: v.string(),
    encryptedAccessToken: v.string(),
    accessTokenExpiresAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (
      connection === null ||
      connection.workspaceId !== args.workspaceId ||
      connection.disconnectedAt !== undefined ||
      connection.googleAccountId !== args.googleAccountId
    ) {
      return false;
    }
    // A replaced agent grant is discarded, not revoked: Google's revoke would
    // end this account's grants to the whole project, the new one included.
    await ctx.db.patch(args.connectionId, {
      agentGrant: {
        encryptedRefreshToken: args.encryptedRefreshToken,
        encryptedAccessToken: args.encryptedAccessToken,
        accessTokenExpiresAt: args.accessTokenExpiresAt,
        scopes: args.scopes,
        grantedAt: Date.now(),
      },
    });
    return true;
  },
});

/**
 * Revoke an agent grant at Google, on an explicit disconnect only, beside the
 * standard grant's own revoke: Google ends the account's grants to every
 * client of this project, which is what disconnecting means. Best effort.
 */
export const revokeAgentGrant = internalAction({
  args: { workspaceId: v.id("workspaces"), encryptedRefreshToken: v.string() },
  returns: v.null(),
  handler: async (_ctx, args): Promise<null> => {
    if (args.encryptedRefreshToken.length === 0) return null;
    try {
      const token = await decryptSecret(args.encryptedRefreshToken, requireKeyset(), { workspaceId: args.workspaceId as string });
      await revokeGoogleToken({ token });
    } catch (error) {
      const code = error instanceof GoogleOAuthError ? error.errorCode : "UNEXPECTED";
      console.log(JSON.stringify({ event: "google.agent_revoke_skipped", workspaceId: args.workspaceId, errorCode: code }));
    }
    return null;
  },
});
