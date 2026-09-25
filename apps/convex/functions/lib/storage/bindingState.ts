/**
 * What the probes found: recording a verification, the bucket's layout state
 * and its note count against the binding row.
 *
 * Split out of `functions/storage.ts`, which keeps every registered storage
 * function and wires these handlers to them; this module registers none and opens no credential.
 */

import { ConvexError, v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { redactSigningArtifacts } from "../verification";
import {
  STORAGE_LAYOUT_PROBE_VERSION,
  storageLayoutStateValidator,
} from "../storageLayout";
import { managedBucketName } from "../managedStorage";
import { capabilitiesValidator } from "./shapes";

/**
 * How much provider failure text we keep.
 *
 * `lastError` is readable by every member of the workspace and is written by
 * whatever performed the probe, so it is an untrusted string on a published
 * surface. A cap stops an unbounded provider response (or a deliberately
 * enormous one) from being stored and served, and keeps the field to the size
 * of the thing it is for: one line a human can act on.
 */
export const MAX_LAST_ERROR_LENGTH = 300;

/**
 * Redact the credential-shaped fragments we can actually recognize.
 *
 * The schema used to claim `lastError` "never contains the secret" with nothing
 * enforcing it. This enforces what is enforceable and no more, which is worth
 * being precise about:
 *
 *  - The **access key id** and the **stored envelope** are values we hold, so
 *    an error echoing them is detectable and gets replaced.
 *  - A signing artifact (`Signature=…`, `Credential=…`, `X-Amz-Security-Token=…`)
 *    is recognizable by shape, so it goes too — S3 error bodies quote the
 *    canonical request, and that is the realistic way one leaks.
 *  - The **plaintext secret** is not something this mutation holds; it exists
 *    only inside `bindStorage` and inside the gateway. It cannot be scrubbed
 *    here by matching, so the rule that the caller must not put it in an error
 *    string remains a rule. Truncation limits the blast radius; it does not
 *    remove it.
 */
export function scrubProviderError(
  raw: string,
  binding: {
    accessKeyId?: string;
    encryptedSecretAccessKey?: string;
    encryptedRefreshToken?: string;
    encryptedAccessToken?: string;
  },
): string {
  let scrubbed = raw;
  // Every credential-shaped value the binding holds, whichever provider it is.
  // Listing them explicitly rather than iterating the row keeps a future
  // non-secret field from being redacted out of an error by accident, and a
  // future secret one from being missed — it has to be named here either way.
  for (const known of [
    binding.encryptedSecretAccessKey,
    binding.accessKeyId,
    binding.encryptedRefreshToken,
    binding.encryptedAccessToken,
  ]) {
    if (typeof known === "string" && known.length > 0) {
      scrubbed = scrubbed.split(known).join("[redacted]");
    }
  }
  // Shared with the verifying action, which applies the same rule to the value
  // it returns. Two redactors that drifted apart would mean one published
  // surface quietly became the weak one.
  scrubbed = redactSigningArtifacts(scrubbed);
  return scrubbed.length > MAX_LAST_ERROR_LENGTH
    ? `${scrubbed.slice(0, MAX_LAST_ERROR_LENGTH - 1)}…`
    : scrubbed;
}

export const recordVerificationArgs = {
  workspaceId: v.id("workspaces"),
  ok: v.boolean(),
  capabilities: v.optional(capabilitiesValidator),
  error: v.optional(v.string()),
  /**
   * The machine-readable companion to `error`. See the schema's `errorCode`
   * and `VerificationErrorCode` in `functions/provisioning.ts`.
   *
   * Not scrubbed, because it is not provider text: the caller picks it from a
   * closed set. A caller that puts a provider string in here is putting
   * unscrubbed text on a published surface — do not.
   */
  errorCode: v.optional(v.string()),
  /**
   * What the prober found in the bucket, and whether it wrote anything.
   *
   * Recorded here rather than computed on read because it is the *observed*
   * state of somebody else's bucket at a moment we had a credential — a query
   * cannot recompute it, and giving one the ability to would mean a public
   * function that opens a credential. See the schema for the closed set.
   *
   * Omitted leaves whatever is on the row, so a re-verification that fails
   * before it gets as far as looking does not erase what the last successful
   * one learned.
   */
  scaffolded: v.optional(v.boolean()),
  scaffoldReason: v.optional(v.string()),
  /**
   * Which keys of the chosen layout are still not in the bucket.
   *
   * Supplied only by a verification that actually attempted a scaffold. A
   * look-only probe omits it, which leaves the previous attempt's list
   * standing — that list is the record of what we still owe this bucket, and
   * it is what lets `applyStructure` tell a scaffold of ours that stopped
   * halfway from a vault that was here before we arrived. Erasing it because
   * a re-verification wandered past would strand the owner.
   */
  scaffoldMissing: v.optional(v.array(v.string())),
  actorUserId: v.optional(v.id("users")),
};

export const recordVerificationReturns = v.null();

/**
 * Record the outcome of an actual round trip to the customer's bucket.
 *
 * Internal, because only something that has genuinely talked to the provider
 * may set `connected` — a client-callable "mark me verified" would let a
 * broken binding claim to be healthy. The gateway calls this after its connect
 * probe, and passes the probed capabilities rather than assumptions.
 */
export async function recordVerificationHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof recordVerificationArgs>,
) {
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (binding === null) {
    throw new ConvexError({
      code: "NO_STORAGE_BINDING",
      message: "This workspace has no storage binding.",
    });
  }

  const now = Date.now();
  await ctx.db.patch(binding._id, {
    status: args.ok ? "connected" : "error",
    capabilities: args.capabilities ?? binding.capabilities,
    lastVerifiedAt: args.ok ? now : binding.lastVerifiedAt,
    // Clearing the error on success matters: a stale `lastError` next to a
    // green status is how support tickets get misdiagnosed.
    lastError: args.ok
      ? undefined
      : scrubProviderError(args.error ?? "Verification failed", binding),
    errorCode: args.ok ? undefined : args.errorCode,
    scaffolded: args.scaffolded ?? binding.scaffolded,
    scaffoldReason: args.scaffoldReason ?? binding.scaffoldReason,
    scaffoldMissing: args.scaffoldMissing ?? binding.scaffoldMissing,
    // Whatever was queued has now been answered, one way or the other.
    scaffoldQueuedAt: undefined,
    updatedAt: now,
  });

  // A managed bucket is not delivered when its row is written; it is
  // delivered when the exact credential the gateway will use has answered.
  // Transient failures inside the IAM propagation window never reach this
  // mutation (the verifier reschedules them), so a failure here is final for
  // this attempt and may truthfully replace the running state.
  if (binding.bucket === managedBucketName(args.workspaceId)) {
    const plan = await ctx.db
      .query("workspacePlans")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (
      plan !== null &&
      plan.managedStorage === true &&
      (plan.managedProvisioning === "running" ||
        plan.managedProvisioning === "failed")
    ) {
      await ctx.db.patch(plan._id, {
        managedProvisioning: args.ok ? "ready" : "failed",
        managedProvisioningError: args.ok ? undefined : args.errorCode,
        managedProvisioningAt: now,
        updatedAt: now,
      });
    }
  }

  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId,
    action: args.ok ? "storage.verified" : "storage.verification_failed",
    details: {
      conditionalWrite: (args.capabilities ?? binding.capabilities)
        .conditionalWrite,
    },
  });
  return null;
}

export const recordStorageLayoutStateArgs = {
  workspaceId: v.id("workspaces"),
  /** Absent means the bucket answered that it has never run this. */
  state: v.optional(storageLayoutStateValidator),
};

export const recordStorageLayoutStateReturns = v.null();

/**
 * Record where the storage-layout migration got to.
 *
 * Internal, and the same shape as `recordNoteCount` for the same reason: it is
 * a thing we observed while holding a credential, which no query can recompute
 * without becoming a public function that opens one.
 *
 * The bucket stays authoritative — `migrateStorageLayout` persists its own
 * state under `.context/` and short-circuits on `complete`. This is the copy
 * the console reads, and it exists because the console had nothing to read:
 * "available" was as close to "pending" as it could get, so the offer to run
 * the migration was answered by a flag on one device and came back on every
 * other one, for a bucket that had already been migrated.
 *
 * Called on every outcome, including the refusals — a bucket without
 * conflict-safe writes answers `unsupported` and that is an answer, not a
 * failure to record. A binding that vanished mid-migration drops the write,
 * exactly as the count does: the state describes a bucket this row no longer
 * names.
 *
 * ## An absent `state` is an answer too, and it is why this takes one
 *
 * `state` is optional because **"we looked, and this bucket has never run the
 * migration" is a different fact from "nobody has looked"** — and the console
 * had no way to tell them apart, so it offered the update to every context
 * migrated before this field existed, for ever, on every device. Recording the
 * *question* separately from the *answer* is what ends that:
 * `storageLayoutCheckedAt` says the bucket was asked, and is set on every call
 * here; `storageLayoutState` stays what it said, and is left absent when it
 * has genuinely never run.
 *
 * A bucket that would not answer at all must not reach this function. That is
 * not a state, it is the absence of an observation, and writing a timestamp
 * for it would claim we know something we do not — `readStorageLayout` returns
 * `observed: false` and its caller records nothing.
 */
export async function recordStorageLayoutStateHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof recordStorageLayoutStateArgs>,
) {
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (binding === null) return null;

  const now = Date.now();
  await ctx.db.patch(binding._id, {
    /*
      Written even when it clears a state we had. The bucket is authoritative
      and this row is a copy of it: a state file that is gone means this
      bucket is no longer migrated as far as anything can tell, and the
      honest consequence is that the console offers the update again. A copy
      that outlived the thing it copied is the stale-green-check failure the
      rebind clear exists to avoid.
    */
    storageLayoutState: args.state,
    ...(args.state === undefined ? {} : { storageLayoutAt: now }),
    storageLayoutCheckedAt: now,
    /*
      And which generation of the question this answer came from. The one
      before it looked only for a migration state file, so a bucket we
      scaffolded ourselves answered "never run" and every new workspace was
      offered an update with nothing behind it. Stamping the answer is what
      lets those rows be asked once more instead of backfilled by hand.
    */
    storageLayoutCheckedVersion: STORAGE_LAYOUT_PROBE_VERSION,
  });
  return null;
}

export const recordNoteCountArgs = {
  workspaceId: v.id("workspaces"),
  notes: v.number(),
  truncated: v.boolean(),
};

export const recordNoteCountReturns = v.null();

/**
 * Record what a walk of the bucket counted. Internal, and separate from
 * `recordVerification` on purpose.
 *
 * They are two different observations, and folding the count into the status
 * write made the status wait on it. The walk is up to forty sequential LIST
 * round trips against somebody else's bucket; with both in one write, all of
 * that sat inside the window where the binding still read `unverified`, and an
 * action that died mid-walk left a perfectly good bucket permanently unverified
 * over a number nobody was waiting for.
 *
 * So the status lands first and this follows. A count that never arrives simply
 * never calls this, which is also why there is no "clear the count" path here:
 * absence is expressed by not calling, and the row keeps what the last real
 * walk found. See `noteCount.ts` for why absent must never become zero.
 */
export async function recordNoteCountHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof recordNoteCountArgs>,
) {
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  // Disconnected or rebound while we were walking. The count describes a
  // bucket this row no longer names, so it is dropped rather than written.
  if (binding === null) return null;

  await ctx.db.patch(binding._id, {
    noteCount: args.notes,
    // Stamped from the walk that produced it, never from the last
    // verification that happened to succeed.
    noteCountedAt: Date.now(),
    noteCountTruncated: args.truncated,
  });
  return null;
}
