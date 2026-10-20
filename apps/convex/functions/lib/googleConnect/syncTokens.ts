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

/**
 * The `reconnect_required` causes a refresh that works disproves: Google's
 * `invalid_grant` (`GRANT_REVOKED`), and the pass code that used to overwrite
 * it on the row (`GOOGLE_RECONNECT_REQUIRED`, before the failed-pass branch
 * of `recordGoogleForwardSyncPass` kept the cause). Never `SCOPES_INCOMPLETE`:
 * a missing permission is the person's to give.
 */
export const REFRESHABLE_RECONNECT_CODES: ReadonlySet<string> = new Set([
  "GRANT_REVOKED",
  "GOOGLE_RECONNECT_REQUIRED",
]);

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
  const now = Date.now();
  /*
    A REFRESH THAT WORKED DISPROVES A REVOKED GRANT.

    `markReconnectRequired` sets `GRANT_REVOKED` on one `invalid_grant`, and
    the sync gate then skipped the row until a fresh connect, so one spurious
    refusal stopped a mailbox for good. Google just accepted this grant, so
    the row is healthy and due now. Only those codes: `SCOPES_INCOMPLETE` is a
    permission the person has to give, which no refresh can.
  */
  const recovered = connection.health === "reconnect_required" && REFRESHABLE_RECONNECT_CODES.has(connection.errorCode ?? "");
  await ctx.db.patch(args.connectionId, {
    encryptedAccessToken: args.encryptedAccessToken,
    accessTokenExpiresAt: args.accessTokenExpiresAt,
    ...(recovered
      ? { health: "active" as const, lastError: undefined, errorCode: undefined, syncFailures: undefined, nextSyncAt: now }
      : {}),
    updatedAt: now,
  });
  if (recovered) {
    console.log(JSON.stringify({ event: "google.grant_recovered", connectionId: args.connectionId }));
  }
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
