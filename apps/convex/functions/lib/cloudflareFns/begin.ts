/**
 * The handlers for `cloudflare.provisionCloudflareR2` and `beginProvisioning`:
 * sealing the setup credential and queuing the work.
 *
 * Split out of `functions/cloudflare.ts` — see that file's header for the
 * whole flow this belongs to and the credential-handling rules it follows.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../../../_generated/server";
import { encryptSecret, requireKeyset } from "../crypto";
import { recordAudit } from "../audit";
import { consumeRateLimit } from "../rateLimit";
import { requireWorkspaceRole } from "../workspaceAuth";
import { managedAccountId, refuseManagedAccountId } from "../managedStorage";
import { bucketNameProblem, isPlausibleAccountId, type R2Jurisdiction } from "../cloudflare";
import { PROVISION_LIMIT, PROVISION_WINDOW_MS, PROVISION_ATTEMPT_TTL_MS } from "./constants";

/**
 * Start provisioning: create a bucket in the customer's Cloudflare account and
 * bind it.
 *
 * An **action**, for the two reasons `bindStorage` is one: sealing the
 * credential is Web Crypto, and the plaintext should exist in as few places as
 * possible — here it lives for the length of one call and is never written
 * anywhere readable.
 *
 * Owner-only. Creating storage for a context is the same authority as
 * repointing it, and the role is checked again inside the mutation because an
 * action's check and its write are not one transaction.
 *
 * Returns as soon as the row is written. The work happens in a scheduled job;
 * watch `getCloudflareProvisioning` and then `getStorageBinding` for the
 * outcome. Nothing about the credential comes back here, by construction.
 */
export async function provisionCloudflareR2Handler(
  ctx: ActionCtx,
  userId: Id<"users">,
  args: {
    workspaceId: Id<"workspaces">;
    credential: { source: "api-token"; apiToken: string; accountId: string };
    bucket: string;
    jurisdiction?: R2Jurisdiction;
    locationHint?: string;
  },
): Promise<{ provisioningId: Id<"cloudflareProvisioning">; status: string }> {
  if (args.credential.apiToken.trim().length === 0) {
    throw new ConvexError({
      code: "INVALID_CREDENTIAL",
      message: "A Cloudflare API token is required.",
    });
  }
  const accountId = args.credential.accountId.trim().toLowerCase();
  if (!isPlausibleAccountId(accountId)) {
    throw new ConvexError({
      code: "INVALID_ACCOUNT_ID",
      message:
        "That does not look like a Cloudflare account id. It is 32 hexadecimal characters, shown on the right of any account's overview page.",
    });
  }
  // The BYO path provisions into an account the customer owns. Ours is not
  // one, and a bucket created there by this flow would be a customer bucket
  // nobody could hand over. No-ops where no managed account is configured.
  refuseManagedAccountId(accountId, managedAccountId());
  const bucket = args.bucket.trim().toLowerCase();
  const problem = bucketNameProblem(bucket);
  if (problem !== null) {
    // Refused here, with a form still on screen, rather than three API calls
    // later as a failed provisioning row.
    throw new ConvexError({ code: "INVALID_BUCKET_NAME", message: problem });
  }

  // Bound to this workspace id, exactly like a storage secret: the mutation
  // authorizes the same id and writes the envelope into that workspace's row,
  // so an envelope and the row holding it cannot disagree about which context
  // they belong to, and a copied row yields a decrypt failure rather than
  // somebody else's account credential.
  const encryptedSetupCredential = await encryptSecret(
    args.credential.apiToken,
    requireKeyset(),
    { workspaceId: args.workspaceId },
  );

  return await ctx.runMutation(internal.functions.cloudflare.beginProvisioning, {
    actorUserId: userId,
    workspaceId: args.workspaceId,
    credentialSource: args.credential.source,
    encryptedSetupCredential,
    accountId,
    bucket,
    jurisdiction: args.jurisdiction ?? "default",
    locationHint: args.locationHint,
  });
}

/**
 * Write the one in-flight row and queue the work. Internal — the plaintext
 * credential never reaches here.
 *
 * `actorUserId` comes from the calling action rather than from auth, which is
 * safe because an internal function is unreachable from any client; the role
 * check below is what authorizes the write.
 *
 * Scheduled rather than awaited, and the reasons are `applyBinding`'s:
 * scheduling inside the mutation queues the job if and only if the row commits;
 * three round trips to Cloudflare must not sit inside the call that returns to
 * a person; and, load-bearing, the job opens a credential, so a public function
 * able to *call* it would have the decrypt path in its call graph. A scheduled
 * function's result is discarded by the scheduler and can never reach whoever
 * queued it.
 */
export async function beginProvisioningHandler(
  ctx: MutationCtx,
  args: {
    actorUserId: Id<"users">;
    workspaceId: Id<"workspaces">;
    credentialSource: "api-token" | "oauth";
    encryptedSetupCredential: string;
    accountId: string;
    bucket: string;
    jurisdiction: R2Jurisdiction;
    locationHint?: string;
  },
): Promise<{ provisioningId: Id<"cloudflareProvisioning">; status: string }> {
  await requireWorkspaceRole(ctx, args.workspaceId, args.actorUserId, "owner");

  // Counted before anything is queued, in the same transaction: a refusal
  // throws and rolls the row back with it, so a job is never queued uncounted
  // and a count never survives a job that was not queued.
  await consumeRateLimit(ctx, {
    key: `storage.provision:${args.workspaceId}`,
    limit: PROVISION_LIMIT,
    windowMs: PROVISION_WINDOW_MS,
  });

  const now = Date.now();
  const existing = await ctx.db
    .query("cloudflareProvisioning")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();

  if (
    existing !== null &&
    existing.status === "pending" &&
    (existing.expiresAt ?? 0) > now
  ) {
    // One at a time. Two concurrent runs would create two buckets and mint
    // two tokens, and only one of them could end up on the binding — the
    // other would be an orphaned credential in the customer's account that
    // nothing here remembers to clean up.
    //
    // Bounded by the row's own deadline, because "in progress" was otherwise
    // permanent: an attempt whose scheduled action never ran left a `pending`
    // row that refused every subsequent attempt forever, with no UI to
    // dismiss it. A row past its deadline is not running, whatever it says.
    throw new ConvexError({
      code: "PROVISION_IN_PROGRESS",
      message:
        "A bucket is already being created for this context. Wait for it to finish, or dismiss it first.",
    });
  }

  const fields = {
    workspaceId: args.workspaceId,
    requestedBy: args.actorUserId,
    credentialSource: args.credentialSource,
    encryptedSetupCredential: args.encryptedSetupCredential,
    accountId: args.accountId,
    bucket: args.bucket,
    jurisdiction: args.jurisdiction,
    locationHint: args.locationHint,
    status: "pending" as const,
    // A retry is a fresh attempt: the previous failure describes a request
    // that is no longer the one in flight.
    errorCode: undefined,
    error: undefined,
    updatedAt: now,
    expiresAt: now + PROVISION_ATTEMPT_TTL_MS,
  };

  let provisioningId: Id<"cloudflareProvisioning">;
  if (existing === null) {
    provisioningId = await ctx.db.insert("cloudflareProvisioning", {
      ...fields,
      createdAt: now,
    });
  } else {
    // `createdAt` is deliberately not in `fields`: it dates the *attempt*,
    // across every retry of it, and `provisionCloudflareStorage` uses it as
    // the proof that a bucket which already exists is one an earlier run of
    // this same attempt created. Resetting it here would quietly turn every
    // retry back into the dead end this row is trying to get out of.
    await ctx.db.patch(existing._id, fields);
    provisioningId = existing._id;
  }

  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId,
    action: "storage.provision_requested",
    details: {
      provider: "r2",
      bucket: args.bucket,
      jurisdiction: args.jurisdiction,
      // What kind of credential was used, never the credential.
      credentialSource: args.credentialSource,
    },
  });

  await ctx.scheduler.runAfter(
    0,
    internal.functions.cloudflare.provisionCloudflareStorage,
    { workspaceId: args.workspaceId },
  );

  return { provisioningId, status: "pending" };
}
