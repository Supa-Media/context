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
