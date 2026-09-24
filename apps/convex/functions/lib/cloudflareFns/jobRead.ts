/**
 * The handler for `cloudflare.getProvisioningJob`.
 *
 * Split out of `functions/cloudflare.ts` — see that file's header for the
 * whole flow this belongs to.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import type { R2Jurisdiction } from "../cloudflare";

export interface ProvisioningJob {
  requestedBy: Id<"users">;
  encryptedSetupCredential?: string;
  accountId: string;
  bucket: string;
  jurisdiction: R2Jurisdiction;
  locationHint?: string;
  status: string;
  /** When this attempt was first written. The anchor for bucket reuse. */
  createdAt: number;
}

/**
 * The in-flight row, envelope included. Internal.
 *
 * Split out so the provisioning action can read it without an action-to-action
 * hop, exactly as `getBindingRow` is. It returns the sealed envelope and never
 * a plaintext; the only caller that can open it is the action below.
 */
export async function getProvisioningJobHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<ProvisioningJob | null> {
  const job = await ctx.db
    .query("cloudflareProvisioning")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (job === null) return null;
  return {
    requestedBy: job.requestedBy,
    encryptedSetupCredential: job.encryptedSetupCredential,
    accountId: job.accountId,
    bucket: job.bucket,
    jurisdiction: job.jurisdiction as R2Jurisdiction,
    locationHint: job.locationHint,
    status: job.status,
    createdAt: job.createdAt,
  };
}
