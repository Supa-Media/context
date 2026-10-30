/**
 * The rows behind `getBindingForGateway`: the sealed binding it reads.
 *
 * Split out of `functions/storage.ts`, which keeps every registered storage
 * function and wires these handlers to them; this module registers none and opens no credential.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
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
    temporaryAccessKeyId: v.optional(v.string()),
    encryptedTemporarySecretAccessKey: v.optional(v.string()),
    encryptedSessionToken: v.optional(v.string()),
    temporaryUntil: v.optional(v.number()),
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
    temporaryAccessKeyId: binding.temporaryAccessKeyId,
    encryptedTemporarySecretAccessKey: binding.encryptedTemporarySecretAccessKey,
    encryptedSessionToken: binding.encryptedSessionToken,
    temporaryUntil: binding.temporaryUntil,
    forcePathStyle: binding.forcePathStyle,
    capabilities: binding.capabilities,
    status: binding.status,
  };
}
