/**
 * The rows behind `getBindingForGateway`: the sealed binding it reads, and the
 * refreshed Dropbox token it writes back. The decrypt itself stays in
 * `functions/storage.ts`.
 *
 * Split out of `functions/storage.ts`, which keeps every registered storage
 * function and wires these handlers to them; this module registers none and opens no credential.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { capabilitiesValidator } from "./shapes";

export const getBindingRowArgs = { workspaceId: v.id("workspaces") };

export const getBindingRowReturns = v.union(
  v.null(),
  v.object({
    provider: v.string(),
    endpoint: v.optional(v.string()),
    region: v.optional(v.string()),
    bucket: v.optional(v.string()),
    rootPrefix: v.optional(v.string()),
    accessKeyId: v.optional(v.string()),
    encryptedSecretAccessKey: v.optional(v.string()),
    // The Dropbox columns. Absent from this validator, Convex strips them
    // from the row and the gateway path reads a connection that looks
    // incomplete — which is exactly how this was found.
    encryptedRefreshToken: v.optional(v.string()),
    encryptedAccessToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    dropboxAccountId: v.optional(v.string()),
    forcePathStyle: v.optional(v.boolean()),
    capabilities: capabilitiesValidator,
    status: v.string(),
  }),
);

/**
 * The binding row with the envelope still sealed. Internal.
 *
 * Split out from `getBindingForGateway` so the decrypting action can read the
 * row without an action-to-action hop, and so nothing that only needs
 * configuration ever has to touch the decryption path.
 */
export async function getBindingRowHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof getBindingRowArgs>,
) {
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (binding === null) return null;
  return {
    provider: binding.provider,
    endpoint: binding.endpoint,
    region: binding.region,
    bucket: binding.bucket,
    rootPrefix: binding.rootPrefix,
    accessKeyId: binding.accessKeyId,
    encryptedSecretAccessKey: binding.encryptedSecretAccessKey,
    encryptedRefreshToken: binding.encryptedRefreshToken,
    encryptedAccessToken: binding.encryptedAccessToken,
    accessTokenExpiresAt: binding.accessTokenExpiresAt,
    dropboxAccountId: binding.dropboxAccountId,
    forcePathStyle: binding.forcePathStyle,
    capabilities: binding.capabilities,
    status: binding.status,
  };
}

/**
 * A usable Dropbox access token, refreshing if the cached one is near expiry.
 *
 * A plain function rather than its own action, deliberately: an internal
 * action here would be a *fourth* enumerated way to reach a decrypted
 * credential, and `__tests__/structure.test.ts` is right that each one needs
 * the scrutiny `getBindingForGateway` got. This does the same work inside the
 * function that already holds that permission, so the blast radius does not
 * grow.
 *
 * ## Refreshed on a clock, not on a 401
 *
 * Finding out a token expired by failing a customer's read is a worse way to
 * learn it: the read has already gone out, it surfaces as a storage outage,
 * and the retry costs a round trip somebody is waiting on. Dropbox access
 * tokens are short by design, so the expiry is stored and consulted, with a
 * minute of margin for a request that takes a moment to arrive.
 */
export const ACCESS_TOKEN_MARGIN_MS = 60_000;

export const recordDropboxRefreshArgs = {
  workspaceId: v.id("workspaces"),
  encryptedAccessToken: v.string(),
  accessTokenExpiresAt: v.number(),
  encryptedRefreshToken: v.optional(v.string()),
};

export const recordDropboxRefreshReturns = v.null();

/**
 * Persist a refreshed pair.
 *
 * Conditional on the binding still being Dropbox: a workspace rebound to a
 * bucket mid-refresh must not have Dropbox tokens written back onto it.
 */
export async function recordDropboxRefreshHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof recordDropboxRefreshArgs>,
) {
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (binding === null || binding.provider !== "dropbox") return null;

  await ctx.db.patch(binding._id, {
    encryptedAccessToken: args.encryptedAccessToken,
    accessTokenExpiresAt: args.accessTokenExpiresAt,
    // Dropbox rotates the refresh token only sometimes. Writing `undefined`
    // over a good one would lose the grant entirely, so it is patched only
    // when a replacement actually arrived.
    ...(args.encryptedRefreshToken
      ? { encryptedRefreshToken: args.encryptedRefreshToken }
      : {}),
    updatedAt: Date.now(),
  });
  return null;
}
