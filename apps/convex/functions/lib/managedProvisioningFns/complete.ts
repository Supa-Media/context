/**
 * The handler for `managedProvisioning.completeManagedProvisioning`.
 *
 * Split out of `functions/managedProvisioning.ts` — see that file's header
 * comment on `provisionManagedStorage` for the whole flow this belongs to.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { R2_CREDENTIAL_SETTLE_MS } from "../cloudflare";

/**
 * Bind the bucket, then let verification mark the plan ready.
 *
 * Through `applyBinding` rather than an insert here, for the reason
 * `completeProvisioning` gives on the BYO path: the field resets, the audit
 * event and the scheduled verification are all that function's, and a second
 * copy of them would drift. A managed binding is written by exactly the code
 * that writes a pasted one, but remains `running` until that scheduled probe
 * proves the newly minted credential works.
 */
export async function completeManagedProvisioningHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    actorUserId: Id<"users">;
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    encryptedSecretAccessKey: string;
  },
): Promise<null> {
  const existing = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  /*
    Never over a binding that arrived while Cloudflare was answering. The
    customer may have connected their own bucket in the meantime, and their
    notes would be behind it.
  */
  if (existing === null) {
    await ctx.runMutation(internal.functions.storage.applyBinding, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      provider: "r2",
      endpoint: args.endpoint,
      region: "auto",
      bucket: args.bucket,
      accessKeyId: args.accessKeyId,
      encryptedSecretAccessKey: args.encryptedSecretAccessKey,
      verificationRetryUntil: Date.now() + R2_CREDENTIAL_SETTLE_MS,
    });
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: "storage.managed_provisioned",
      // The bucket name is the workspace id — not a secret, and the one fact
      // support needs to find it in the dashboard. No credential, no
      // endpoint, and nothing about what is in it.
      details: { bucket: args.bucket },
    });
  }
  return null;
}
