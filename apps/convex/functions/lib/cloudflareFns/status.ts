/**
 * The handlers for `cloudflare.getCloudflareProvisioning` and
 * `dismissProvisioning`.
 *
 * Split out of `functions/cloudflare.ts` — see that file's header for the
 * whole flow this belongs to.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { requireWorkspaceAccess, requireWorkspaceRole } from "../workspaceAuth";

/**
 * What the console may see about an attempt: is one running, and if it failed,
 * why.
 *
 * Any member, like `getStorageBinding` — knowing that your context's storage is
 * being set up is not a privileged fact, and hiding it from a read-only member
 * just means they cannot tell a broken context from an empty one. The sealed
 * credential is not in the return type in any form, and after a failure it is
 * not on the row either.
 */
export async function getCloudflareProvisioningHandler(
  ctx: QueryCtx,
  actorUserId: Id<"users">,
  workspaceId: Id<"workspaces">,
): Promise<{
  status: string;
  bucket: string;
  jurisdiction: string;
  errorCode?: string;
  error?: string;
  updatedAt: number;
} | null> {
  await requireWorkspaceAccess(ctx, workspaceId, actorUserId);

  const job = await ctx.db
    .query("cloudflareProvisioning")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (job === null) return null;
  return {
    status: job.status,
    bucket: job.bucket,
    jurisdiction: job.jurisdiction,
    errorCode: job.errorCode,
    error: job.error,
    updatedAt: job.updatedAt,
  };
}

/**
 * Forget an attempt.
 *
 * Two uses, and the second is why it accepts a `pending` row as well as a
 * failed one. Dismissing a failure clears the banner; dismissing a run that is
 * stuck — a scheduled job lost to a deploy, a Cloudflare call that never
 * returned — destroys the sealed setup credential immediately rather than
 * leaving it to sit. A job that is still running finds no row when it goes to
 * finish, and does nothing.
 *
 * Owner-only, and a hard delete: "we are not holding your Cloudflare token" has
 * to mean the row is gone. Anything already created in the customer's account
 * stays there and belongs to them; the audit event survives, carrying no
 * credential.
 */
export async function dismissProvisioningHandler(
  ctx: MutationCtx,
  actorUserId: Id<"users">,
  workspaceId: Id<"workspaces">,
): Promise<{ dismissed: boolean }> {
  await requireWorkspaceRole(ctx, workspaceId, actorUserId, "owner");

  const job = await ctx.db
    .query("cloudflareProvisioning")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (job === null) return { dismissed: false };

  await ctx.db.delete(job._id);
  await recordAudit(ctx, {
    workspaceId,
    actorUserId,
    action: "storage.provision_dismissed",
    details: { provider: "r2", bucket: job.bucket, fromStatus: job.status },
  });
  return { dismissed: true };
}
