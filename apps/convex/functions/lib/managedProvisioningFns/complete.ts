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
import { managedBucketBound } from "../managedEncryptionFns/rollout";
import { PARA_FOLDERS } from "../scaffold";
import { schedulePromotion, type SealedTemporaryCredential } from "./temporaryKey";

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
    temporary?: SealedTemporaryCredential;
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
    /*
      A personal workspace's new bucket gets the five folders from the same
      check that waits out the key's propagation (decided by the owner,
      2026-10-16: a bucket we made is laid out, nobody is asked). Asking for
      them from the browser once that check passed cost a second probe, and
      kept the first run on "Creating your bucket" until it had — the wait
      somebody signing up was left looking at. A shared workspace's kind is
      still its own question, asked in the console.
    */
    const workspace = await ctx.db.get(args.workspaceId);
    const laysOut = workspace?.kind === "personal";
    if (laysOut) {
      await ctx.db.patch(args.workspaceId, { structureTemplate: "para", updatedAt: Date.now() });
    }
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
      ...(args.temporary === undefined ? {} : { temporary: args.temporary }),
      ...(laysOut ? { firstStructure: { template: "para" as const, folders: [], kind: "personal" as const } } : {}),
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
    if (laysOut) {
      // The same record `applyStructure` leaves, with the acting person.
      await recordAudit(ctx, {
        workspaceId: args.workspaceId,
        actorUserId: args.actorUserId,
        action: "workspace.structure_applied",
        details: { template: "para", folderCount: PARA_FOLDERS.length },
      });
    }
    if (args.temporary !== undefined) {
      await schedulePromotion(ctx, { workspaceId: args.workspaceId, attempt: 0, until: args.temporary.until });
    }
    // Joins the encryption rollout when staff set it to cover every managed
    // workspace, or re-walks a re-adopted bucket that holds sealed files.
    await managedBucketBound(ctx, args.workspaceId);
  }
  return null;
}
