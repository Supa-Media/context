/**
 * The two halves of a standard provider's consent that open a sealed secret
 * (a registered client's, or the PKCE verifier), kept internal so no public
 * function reaches a decrypt (`__tests__/structure/reachability.test.ts`).
 * `functions/connections.ts`'s public actions call these after they have
 * checked who is asking and parked or spent the attempt.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { decryptSecret, encryptSecret, requireKeyset } from "./lib/crypto";
import { exchangeStandard, resolveClient } from "./lib/connections/standard";
import { resolveClientInfo, resourceFor, scopesFor } from "./lib/connections/standardClient";
import { createPkcePair } from "./lib/pkce";
import { providerValidator } from "./lib/providers/ids";
import { standardAuthorizeUrl } from "./lib/providers/oauth";
import { providerOf } from "./lib/providers/registry";

/** The consent address for a parked attempt, its verifier sealed to the attempt's workspace. Null: not set up. */
export const standardConsentUrl = internalAction({
  args: {
    provider: providerValidator,
    workspaceId: v.id("workspaces"),
    hashedState: v.string(),
    hashedCompletion: v.string(),
    state: v.string(),
    redirectUri: v.string(),
  },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args): Promise<string | null> => {
    const spec = providerOf(args.provider);
    if (spec === null || spec.kind === "slack") return null;
    // No secret is opened to start a consent; a public action reaches this.
    const found = await resolveClientInfo(ctx, spec, args.redirectUri);
    if (found === null) return null;
    const { client } = found;
    const { verifier, challenge } = await createPkcePair();
    const sealed: boolean = await ctx.runMutation(internal.functions.connections.sealAttemptVerifier, {
      hashedState: args.hashedState,
      hashedCompletion: args.hashedCompletion,
      encryptedVerifier: await encryptSecret(verifier, requireKeyset(), { workspaceId: args.workspaceId as string }),
    });
    if (!sealed) return null;
    return standardAuthorizeUrl(client, {
      redirectUri: args.redirectUri,
      state: args.state,
      codeChallenge: challenge,
      scopes: scopesFor(spec, client),
      resource: resourceFor(spec, client),
      extra: spec.authorizeParams,
    });
  },
});

/**
 * Exchange a spent attempt's code and keep the connection, scheduled by the
 * callback (a scheduled call is not a call: the public action reaches no
 * decrypt). The callback page watches `connectionState` for the row.
 */
export const finishStandardConsent = internalAction({
  args: {
    provider: providerValidator,
    workspaceId: v.id("workspaces"),
    linkId: v.id("providerConnectLinks"),
    connectedBy: v.id("users"),
    scope: v.union(v.literal("personal"), v.literal("workspace")),
    encryptedVerifier: v.string(),
    code: v.string(),
    redirectUri: v.string(),
  },
  returns: v.union(v.null(), v.object({ teamName: v.string(), workspaceName: v.string() })),
  handler: async (ctx, args): Promise<{ teamName: string; workspaceName: string } | null> => {
    const spec = providerOf(args.provider);
    if (spec === null || spec.kind === "slack") return null;
    const client = await resolveClient(ctx, spec, args.redirectUri);
    if (client === null) {
      await ctx.runMutation(internal.functions.connections.noteConnectFailed, { workspaceId: args.workspaceId, userId: args.connectedBy, provider: args.provider });
      return null;
    }
    const keyset = requireKeyset();
    const binding = { workspaceId: args.workspaceId as string };
    const token = await exchangeStandard(spec, client, {
      code: args.code,
      redirectUri: args.redirectUri,
      codeVerifier: await decryptSecret(args.encryptedVerifier, keyset, binding),
    });
    if (token === null) {
      await ctx.runMutation(internal.functions.connections.noteConnectFailed, { workspaceId: args.workspaceId, userId: args.connectedBy, provider: args.provider });
      return null;
    }
    const stored: { workspaceName: string } = await ctx.runMutation(internal.functions.connections.storeConnection, {
      provider: args.provider,
      workspaceId: args.workspaceId,
      linkId: args.linkId,
      connectedBy: args.connectedBy,
      scope: args.scope,
      encryptedAccessToken: await encryptSecret(token.accessToken, keyset, binding),
      ...(token.refreshToken === undefined ? {} : { encryptedRefreshToken: await encryptSecret(token.refreshToken, keyset, binding) }),
      ...(token.expiresInMs === undefined ? {} : { accessTokenExpiresAt: Date.now() + token.expiresInMs }),
      grantedScopes: token.scopes,
      externalAccountId: token.accountId,
      externalTeamId: token.teamId,
      externalTeamName: token.teamName,
    });
    return { teamName: token.teamName, workspaceName: stored.workspaceName };
  },
});
