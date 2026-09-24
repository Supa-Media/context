/**
 * The handlers for `cloudflare.completeProvisioning` and `failProvisioning`,
 * and the shared `markAttemptFailed` they and the sweep use.
 *
 * Split out of `functions/cloudflare.ts` — see that file's header for the
 * whole flow this belongs to and the credential-handling rules it follows.
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { R2_CREDENTIAL_SETTLE_MS, R2_REGION } from "../cloudflare";
import { FAILED_ATTEMPT_RETENTION_MS } from "./constants";

/**
 * Bind the freshly created bucket and forget the attempt, in one transaction.
 *
 * Both halves matter and neither may outlive the other. Deleting the row is how
 * the sealed setup credential stops existing; writing the binding through
 * `applyBinding` rather than inserting here is how this path and the manual
 * one stay the same code — the field resets, the audit event and the scheduled
 * verification are all that function's, and a second copy of them would drift.
 * It also re-authorizes the owner at write time, which is the check that
 * matters, since membership can have changed while Cloudflare was answering.
 */
export async function completeProvisioningHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    actorUserId: Id<"users">;
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    encryptedSecretAccessKey: string;
    forcePathStyle?: boolean;
    /**
     * True when the bucket was created by an earlier run of this same attempt
     * rather than by this one. Recorded because "Context created a bucket in
     * your account" and "Context used a bucket it had already created" are
     * different facts, and the audit trail is where somebody checks which.
     */
    reusedExistingBucket?: boolean;
  },
): Promise<null> {
  const job = await ctx.db
    .query("cloudflareProvisioning")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (job !== null) await ctx.db.delete(job._id);

  await ctx.runMutation(internal.functions.storage.applyBinding, {
    actorUserId: args.actorUserId,
    workspaceId: args.workspaceId,
    provider: "r2",
    endpoint: args.endpoint,
    region: R2_REGION,
    bucket: args.bucket,
    accessKeyId: args.accessKeyId,
    encryptedSecretAccessKey: args.encryptedSecretAccessKey,
    forcePathStyle: args.forcePathStyle,
    /*
      The key in this row was minted seconds ago, so the probe `applyBinding`
      schedules is racing R2's IAM propagation and will lose some of the time.
      Without this window it loses loudly: the connection is painted red, and
      Re-verify — which changes nothing — fixes it. That is a race being shown
      to somebody as a fault, and it is the same one `completeManagedProvisioning`
      already waits out on the bucket we pay for.
    */
    verificationRetryUntil: Date.now() + R2_CREDENTIAL_SETTLE_MS,
  });

  // Distinct from `storage.bound`, which `applyBinding` records: this says a
  // bucket was created in the customer's account by us, which is a different
  // fact and one they should be able to find later. No credential, no token
  // id, no account id beyond what the endpoint already carries.
  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId,
    action: "storage.provisioned",
    details: {
      provider: "r2",
      bucket: args.bucket,
      endpoint: args.endpoint,
      reusedExistingBucket: args.reusedExistingBucket ?? false,
    },
  });
  return null;
}

/**
 * Record a failure and drop the setup credential.
 *
 * The row stays so the owner can read what happened; the envelope does not,
 * because a finished attempt has no further use for a credential that can
 * create buckets. `errorCode` is ours from a closed set, `error` is our
 * sentence plus Cloudflare's own detail, already redacted and truncated by the
 * caller — the one place that holds the plaintext is the one place that can
 * scrub it.
 */
export async function failProvisioningHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; errorCode: string; error: string },
): Promise<null> {
  const job = await ctx.db
    .query("cloudflareProvisioning")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (job === null) return null;

  await markAttemptFailed(ctx, job, args.errorCode, args.error);
  return null;
}

/**
 * Record a failure on one row: the reason stays, the credential goes.
 *
 * Shared by `failProvisioning` and by the sweep, because they are the same
 * event arriving two ways — an attempt that answered and an attempt that never
 * did — and the half that must not fork is the one that destroys the envelope.
 */
export async function markAttemptFailed(
  ctx: MutationCtx,
  job: Doc<"cloudflareProvisioning">,
  errorCode: string,
  error: string,
): Promise<void> {
  await ctx.db.patch(job._id, {
    status: "failed",
    errorCode,
    error,
    // Setting it to `undefined` removes the field. This is the line that
    // makes the credential's lifetime the length of one attempt.
    encryptedSetupCredential: undefined,
    updatedAt: Date.now(),
    // The row's next deadline is the record's, not the credential's: there is
    // no credential on it any more. Moving it forward is also what takes the
    // row out of the sweep's range, so a failed row is not re-read every hour.
    expiresAt: Date.now() + FAILED_ATTEMPT_RETENTION_MS,
  });

  await recordAudit(ctx, {
    workspaceId: job.workspaceId,
    actorUserId: job.requestedBy,
    action: "storage.provision_failed",
    // The code only. `error` may carry provider prose and belongs on the row
    // the owner reads, not in an event stream several people can read.
    details: { provider: "r2", bucket: job.bucket, errorCode },
  });
}
