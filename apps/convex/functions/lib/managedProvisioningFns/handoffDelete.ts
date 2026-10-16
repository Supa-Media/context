/**
 * The handoff's deletion, a week after a verified customer cutover
 * (`managedProvisioning.deleteManagedStorageAfterHandoff` delegates here). Moved
 * out unchanged to keep `managedProvisioning.ts` under its size limit.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { emptyAndDeleteR2Bucket, revokeApiToken } from "../cloudflare";
import { MANAGED_R2_API_TOKEN_SECRET, managedAccountId, managedBucketName } from "../managedStorage";

export async function deleteManagedStorageAfterRetention(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; bucket: string; tokenId: string; retainedUntil?: number },
): Promise<null> {
  const standing: { inUse: boolean; tokenLive: boolean } = await ctx.runQuery(
    internal.functions.managedProvisioning.managedBucketInUse,
    { workspaceId: args.workspaceId, tokenId: args.tokenId, retainedUntil: args.retainedUntil },
  );
  await ctx.runMutation(internal.functions.managedProvisioning.clearManagedRetention, {
    workspaceId: args.workspaceId,
    retainedUntil: args.retainedUntil,
  });
  if (!standing.inUse) {
    await deleteManagedResources(ctx, args);
    // Only once the bucket is gone: until then its sealed files need the row.
    await ctx.runMutation(internal.functions.managedEncryption.forgetKeptBucket, {
      workspaceId: args.workspaceId,
    });
    return null;
  }
  // Switched back inside the week: the bucket stays. The provisioning run that
  // re-adopted it minted a token of its own, so the one from before the move
  // opens nothing anyone holds and is revoked rather than left standing.
  if (!standing.tokenLive) await revokeRetiredToken(ctx, args.tokenId);
  return null;
}

async function revokeRetiredToken(ctx: ActionCtx, tokenId: string): Promise<void> {
  const accountId = managedAccountId();
  const apiToken = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
    name: MANAGED_R2_API_TOKEN_SECRET,
  });
  if (accountId === null || typeof apiToken !== "string" || apiToken.length === 0) return;
  await revokeApiToken({ apiToken, accountId, tokenId });
}

async function deleteManagedResources(ctx: ActionCtx, args: { workspaceId: Id<"workspaces">; bucket: string; tokenId: string }): Promise<null> {
  if (args.bucket !== managedBucketName(args.workspaceId)) {
    throw new Error("Refusing to delete a bucket outside the managed workspace boundary.");
  }
  const accountId = managedAccountId();
  const apiToken = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
    name: MANAGED_R2_API_TOKEN_SECRET,
  });
  if (accountId === null || typeof apiToken !== "string" || apiToken.length === 0) {
    throw new Error("Managed R2 cleanup is not configured.");
  }
  let bucketFailure: unknown;
  try {
    await emptyAndDeleteR2Bucket({ apiToken, accountId, bucket: args.bucket });
  } catch (error) {
    bucketFailure = error;
  }
  // Revoke even when emptying fails: leaving a standing bucket credential is
  // strictly worse than leaving an unreachable bucket for operator cleanup.
  const revoked = await revokeApiToken({ apiToken, accountId, tokenId: args.tokenId });
  if (bucketFailure !== undefined) throw bucketFailure;
  if (!revoked) throw new Error("Managed bucket was deleted but its scoped token could not be revoked.");
  return null;
}
