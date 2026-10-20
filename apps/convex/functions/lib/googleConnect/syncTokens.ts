/**
 * The rows `mintGoogleAccessToken` reads and writes around the refresh it
 * performs: the connection it syncs, the cached short-lived token, and the
 * reconnect flag. The refresh token is opened only in
 * `functions/googleConnect.ts`.
 *
 * Split out of `functions/googleConnect.ts`, which keeps every registered
 * function and wires these handlers to them; this module registers none and opens no credential.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";

export const getConnectionForSyncArgs = { connectionId: v.id("googleConnections") };

export const getConnectionForSyncReturns = v.union(
  v.null(),
  v.object({
    workspaceId: v.id("workspaces"),
    encryptedRefreshToken: v.string(),
    encryptedAccessToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    disconnectedAt: v.optional(v.number()),
  }),
);

export async function getConnectionForSyncHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof getConnectionForSyncArgs>,
) {
  const connection = await ctx.db.get(args.connectionId);
  if (connection === null) return null;
  return {
    workspaceId: connection.workspaceId,
    encryptedRefreshToken: connection.encryptedRefreshToken,
    encryptedAccessToken: connection.encryptedAccessToken,
    accessTokenExpiresAt: connection.accessTokenExpiresAt,
    disconnectedAt: connection.disconnectedAt,
  };
}

export const cacheAccessTokenArgs = {
  connectionId: v.id("googleConnections"),
  encryptedAccessToken: v.string(),
  accessTokenExpiresAt: v.number(),
};

export const cacheAccessTokenReturns = v.null();

export async function cacheAccessTokenHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof cacheAccessTokenArgs>,
) {
  const connection = await ctx.db.get(args.connectionId);
  if (connection === null || connection.disconnectedAt !== undefined) return null;
  await ctx.db.patch(args.connectionId, {
    encryptedAccessToken: args.encryptedAccessToken,
    accessTokenExpiresAt: args.accessTokenExpiresAt,
    updatedAt: Date.now(),
  });
  return null;
}

export const markReconnectRequiredArgs = { connectionId: v.id("googleConnections") };

export const markReconnectRequiredReturns = v.null();

export async function markReconnectRequiredHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof markReconnectRequiredArgs>,
) {
  const connection = await ctx.db.get(args.connectionId);
  if (connection === null || connection.disconnectedAt !== undefined) return null;
  await ctx.db.patch(args.connectionId, {
    health: "reconnect_required" as const,
    lastError: "Google no longer accepts this authorization. Reconnect to continue.",
    errorCode: "GRANT_REVOKED",
    updatedAt: Date.now(),
  });
  return null;
}

/**
 * What one mint came to (`mintGoogleAccessTokenOutcome`). Only
 * `reconnect_required` is Google refusing the grant (`invalid_grant`), and it
 * is the only one that may tell the person to reconnect; `unavailable` is
 * Google not answering, and lifts by itself; `refused` is a disconnected row
 * or this deployment's own configuration.
 */
export type MintOutcome =
  | { kind: "minted"; accessToken: string; expiresAt: number }
  | { kind: "reconnect_required" }
  | { kind: "unavailable" }
  | { kind: "refused" };

export const mintOutcomeValidator = v.union(
  v.object({ kind: v.literal("minted"), accessToken: v.string(), expiresAt: v.number() }),
  v.object({ kind: v.literal("reconnect_required") }),
  v.object({ kind: v.literal("unavailable") }),
  v.object({ kind: v.literal("refused") }),
);

export const dropCachedAccessTokenArgs = { connectionId: v.id("googleConnections") };

/**
 * Forget the cached access token after Google answered a call with 401, so
 * the next mint refreshes instead of handing the refused token out again
 * until it expires by itself.
 */
export async function dropCachedAccessTokenHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof dropCachedAccessTokenArgs>,
) {
  const connection = await ctx.db.get(args.connectionId);
  if (connection === null || connection.encryptedAccessToken === undefined) return null;
  await ctx.db.patch(args.connectionId, {
    encryptedAccessToken: undefined,
    accessTokenExpiresAt: undefined,
    updatedAt: Date.now(),
  });
  return null;
}
