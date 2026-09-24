/**
 * Creating a bucket for somebody who does not have one yet.
 *
 * `functions/storage.ts` is the manual path: a person makes a bucket and an S3
 * key themselves and pastes both. That is the honest shape of the product — the
 * customer owns the storage — and it is also a wall in front of everybody who
 * has a Cloudflare account but has never opened R2. This module removes the
 * wall without moving the wall: given one credential that can act on the
 * customer's own Cloudflare account, we create a bucket **in their account**,
 * mint an S3 key scoped to that one bucket, and store exactly what a manual
 * connect would have stored. Nothing about ownership changes. They can see both
 * objects in their own dashboard and revoke either without telling us.
 *
 * ## The setup credential is the whole problem
 *
 * The credential that can create a bucket can also mint further credentials.
 * It is categorically more dangerous than the bucket key it produces, and it is
 * the customer's account-level credential rather than ours. So:
 *
 *  - it is **never written to the database in the clear**, never logged, never
 *    put in an error string, and never returned by any function here;
 *  - it exists sealed — AES-GCM, bound to the workspace — for the seconds
 *    between the person pressing the button and the bucket existing, and the
 *    row holding it is deleted on success and stripped of it on failure;
 *  - `__tests__/cloudflare.test.ts` runs the whole flow and asserts the token's
 *    literal value appears in no table and in nothing any public function
 *    returns.
 *
 * ## Why the flow is split the way it is
 *
 * It is the `bindStorage` shape, for the reason CLAUDE.md gives under
 * "Scheduling is not calling": a public function may *cause* work that opens a
 * credential, and may never *call* it. So the public action encrypts what it
 * was given and hands it to an internal mutation, which writes one row and
 * schedules the provisioning action. The scheduler discards that action's
 * return value, so there is no channel back to the person who started it — and
 * the provisioning action is consequently the only place in this module that
 * opens anything.
 *
 * ## Two credential sources, one downstream
 *
 * Cloudflare shipped third-party OAuth, whose consent screen includes account
 * selection — which is exactly the thing the paste path cannot do and why the
 * account id is a field a person has to type today. Downstream the two are
 * identical: both are a `Bearer` value on an HTTPS request, so `credentialSource`
 * is recorded and not branched on, and the OAuth path is an acquisition step
 * above this module rather than a second flow through it.
 *
 * **It is not implemented, and two questions must be answered before it can
 * be.** They are written out in full at the top of `lib/cloudflare.ts`: the
 * OAuth scope name for R2 is unpublished, and it is undocumented whether an
 * OAuth access token authenticates against the Cloudflare v4 API at all. No
 * scope name is guessed at anywhere in this repository, and the public entry
 * point accepts `api-token` only.
 *
 * ## Layout of this module
 *
 * Every export below is a thin Convex registration whose handler delegates to
 * `lib/cloudflareFns/`, where the logic (and its comments) actually live —
 * **except `provisionCloudflareStorage`**, whose `decryptSecret` call stays
 * here: `__tests__/structure.test.ts` enumerates exactly which modules may
 * import `decryptSecret` at all, and this file is one of them. Everything that
 * function does *after* opening the credential is `runProvisionAttempt` in
 * `lib/cloudflareFns/provision.ts`, which takes the opened credential as a
 * plain argument and never imports the decrypt itself.
 */

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuthId } from "@supa-media/convex/auth";
import { internal } from "../_generated/api";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { decryptSecret, requireKeyset } from "./lib/crypto";
import { getCloudflareSetupLinkHandler } from "./lib/cloudflareFns/setupLink";
import { beginProvisioningHandler, provisionCloudflareR2Handler } from "./lib/cloudflareFns/begin";
import { getProvisioningJobHandler } from "./lib/cloudflareFns/jobRead";
import { recordProvisionFailure, runProvisionAttempt } from "./lib/cloudflareFns/provision";
import { completeProvisioningHandler, failProvisioningHandler } from "./lib/cloudflareFns/complete";
import { purgeExpiredProvisioningHandler } from "./lib/cloudflareFns/sweep";
import { dismissProvisioningHandler, getCloudflareProvisioningHandler } from "./lib/cloudflareFns/status";
import { jurisdictionValidator, type ProvisionOutcome } from "./lib/cloudflareFns/constants";
export type { ProvisionOutcome } from "./lib/cloudflareFns/constants";

/**
 * The dashboard link that pre-fills an API token form, and a bucket name to
 * start from.
 *
 * Owner-only, because it is part of connecting storage and because the
 * suggestion is derived from the workspace's own slug. Nothing here is a
 * secret — it is a URL anyone could type — but there is no reason for it to be
 * an unauthenticated endpoint either.
 *
 * The `accountId` field in the response is the honest part: a token pasted from
 * this link cannot tell us which Cloudflare account it belongs to, so the
 * person has to supply it. See `apiTokenTemplateUrl` for why.
 */
export const getCloudflareSetupLink = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    url: v.string(),
    suggestedBucket: v.string(),
    /** True while the paste path is the only one. See the module docstring. */
    accountIdRequired: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    return await getCloudflareSetupLinkHandler(ctx, userId, args.workspaceId);
  },
});

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
export const provisionCloudflareR2 = action({
  args: {
    workspaceId: v.id("workspaces"),
    credential: v.object({
      /**
       * Only the paste path exists. Widening this to accept an OAuth access
       * token is a one-literal change *plus* answering the two open questions
       * in `lib/cloudflare.ts` — and it must not be done in the other order.
       */
      source: v.literal("api-token"),
      /** The customer's Cloudflare API token. Discarded once the bucket exists. */
      apiToken: v.string(),
      /** Which of their accounts to create the bucket in. Typed by hand today. */
      accountId: v.string(),
    }),
    bucket: v.string(),
    jurisdiction: v.optional(jurisdictionValidator),
    /** R2's optional placement hint, e.g. `weur`. Passed through untouched. */
    locationHint: v.optional(v.string()),
  },
  returns: v.object({
    provisioningId: v.id("cloudflareProvisioning"),
    status: v.string(),
  }),
  // Annotated rather than inferred: this action calls a function in its own
  // module, which is the inference cycle `bindStorage` documents.
  handler: async (
    ctx,
    args,
  ): Promise<{ provisioningId: Id<"cloudflareProvisioning">; status: string }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({
        code: "NOT_AUTHENTICATED",
        message: "Not authenticated",
      });
    }
    return await provisionCloudflareR2Handler(ctx, userId as Id<"users">, args);
  },
});

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
export const beginProvisioning = internalMutation({
  args: {
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    credentialSource: v.union(v.literal("api-token"), v.literal("oauth")),
    encryptedSetupCredential: v.string(),
    accountId: v.string(),
    bucket: v.string(),
    jurisdiction: jurisdictionValidator,
    locationHint: v.optional(v.string()),
  },
  returns: v.object({
    provisioningId: v.id("cloudflareProvisioning"),
    status: v.string(),
  }),
  handler: async (ctx, args) => beginProvisioningHandler(ctx, args),
});

/**
 * The in-flight row, envelope included. Internal.
 *
 * Split out so the provisioning action can read it without an action-to-action
 * hop, exactly as `getBindingRow` is. It returns the sealed envelope and never
 * a plaintext; the only caller that can open it is the action below.
 */
export const getProvisioningJob = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({
      requestedBy: v.id("users"),
      encryptedSetupCredential: v.optional(v.string()),
      accountId: v.string(),
      bucket: v.string(),
      jurisdiction: jurisdictionValidator,
      locationHint: v.optional(v.string()),
      status: v.string(),
      /** When this attempt was first written. The anchor for bucket reuse. */
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => getProvisioningJobHandler(ctx, args),
});

/**
 * Create the bucket, mint the key, bind it, and forget the setup credential.
 * INTERNAL ACTION — it opens the sealed setup credential.
 *
 * This is the second decrypt in the control plane and it is not the storage
 * one: what it opens is the customer's *Cloudflare account* credential, which
 * is strictly more powerful than the bucket key that ends up on the binding.
 * `__tests__/structure.test.ts` pins the set of functions that can reach a
 * decrypt, and this module's entry in that list carries the same argument.
 *
 * Three properties, in order of how badly each fails:
 *
 *  1. **The plaintext leaves in nothing.** It is used to sign three requests to
 *     Cloudflare and is passed to `redactSecrets` on every path that records
 *     text. The minted token's value joins it there the moment it exists,
 *     because that value is also a Cloudflare credential — only its SHA-256 is
 *     ever stored.
 *  2. **A correctly scoped key or none at all.** The permission group is
 *     resolved by name before the bucket is created, so a Cloudflare that
 *     cannot offer it costs us nothing and leaves nothing behind. There is no
 *     branch anywhere that mints a broader key because the narrow one was
 *     unavailable.
 *  3. **Every failure is recorded and none of them throws.** A missing
 *     entitlement, a taken name and a rejected token are *results* the owner
 *     reads off the row, not exceptions that vanish into a log.
 *  4. **A recorded failure says what is in the customer's account.** The
 *     expected failure of this flow creates a bucket and is then refused at the
 *     mint (open question 3 in `lib/cloudflare.ts`), and the message used to
 *     say "Nothing was changed; try again shortly" — which sent the owner
 *     straight into `BUCKET_NAME_TAKEN` on the bucket we had just made for
 *     them. So `stage` travels with every failure and the message is composed
 *     from it: a failure before the bucket call may say nothing was created, a
 *     failure after it must not, and a call that never got an answer says so.
 *  5. **A bucket we created is reused, and one we did not is never touched.**
 *     A taken name is a question, not a verdict, and the answer is Cloudflare's
 *     own record of when that bucket was created — not our memory, and not an
 *     assumption. Anything unknown refuses. See `bucketCreatedDuringAttempt`.
 *
 * The credential this flow can lose is the *minted* one: everything after the
 * mint — the derive, the encrypt, the binding write, an eviction — leaves a
 * live R2 token in the customer's account whose id exists nowhere but a local
 * variable. The catch below deletes it, and when it cannot, the recorded
 * message names it so somebody can.
 *
 * Idempotent in the only sense that matters: it does nothing unless there is a
 * `pending` row with an envelope on it, and the first thing success does is
 * delete that row. What bounds the case where it never runs at all is
 * `purgeExpiredProvisioning`, not this function.
 *
 * **Everything after the decrypt below is `runProvisionAttempt` in
 * `lib/cloudflareFns/provision.ts`** — split out because it never needs to
 * touch `decryptSecret` itself, only the credential this handler already
 * opened.
 */
export const provisionCloudflareStorage = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ ok: v.boolean(), errorCode: v.optional(v.string()) }),
  handler: async (ctx, args): Promise<ProvisionOutcome> => {
    const job = await ctx.runQuery(
      internal.functions.cloudflare.getProvisioningJob,
      { workspaceId: args.workspaceId },
    );
    if (
      job === null ||
      job.status !== "pending" ||
      job.encryptedSetupCredential === undefined
    ) {
      // Dismissed, already finished, or never there. Not a failure, and
      // deliberately not recorded as one: there is no row to record it on.
      return { ok: false };
    }

    /** Everything that must never appear in recorded text. Grows as we go. */
    const secrets: string[] = [];

    let setupCredential: string;
    try {
      setupCredential = await decryptSecret(
        job.encryptedSetupCredential,
        requireKeyset(),
        { workspaceId: args.workspaceId },
      );
    } catch {
      // A rotated-away key, or an envelope that belongs to another workspace.
      // No detail: the underlying distinctions are an oracle, and the owner's
      // move is the same either way.
      return await recordProvisionFailure(
        ctx,
        args.workspaceId,
        job,
        secrets,
        "resolve-permission-group",
        false,
        "PROVISION_FAILED",
        "The Cloudflare credential you supplied could not be opened. Start again with a fresh token.",
        "",
      );
    }
    secrets.push(setupCredential);

    return await runProvisionAttempt(ctx, args.workspaceId, job, setupCredential, secrets);
  },
});

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
export const completeProvisioning = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    endpoint: v.string(),
    bucket: v.string(),
    accessKeyId: v.string(),
    encryptedSecretAccessKey: v.string(),
    forcePathStyle: v.optional(v.boolean()),
    /**
     * True when the bucket was created by an earlier run of this same attempt
     * rather than by this one. Recorded because "Context created a bucket in
     * your account" and "Context used a bucket it had already created" are
     * different facts, and the audit trail is where somebody checks which.
     */
    reusedExistingBucket: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => completeProvisioningHandler(ctx, args),
});

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
export const failProvisioning = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    errorCode: v.string(),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => failProvisioningHandler(ctx, args),
});

/**
 * Retire attempts that stopped without saying so, and delete dead records.
 *
 * See `lib/cloudflareFns/sweep.ts`'s `purgeExpiredProvisioningHandler` for
 * why the first half is a credential control and the second is ordinary
 * housekeeping.
 */
export const purgeExpiredProvisioning = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({
    expired: v.number(),
    deleted: v.number(),
    moreRemaining: v.boolean(),
  }),
  handler: async (ctx, args) => purgeExpiredProvisioningHandler(ctx, args),
});

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
export const getCloudflareProvisioning = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({
      status: v.string(),
      bucket: v.string(),
      jurisdiction: v.string(),
      /** A `ProvisionErrorCode`; anything unrecognised should show `error`. */
      errorCode: v.optional(v.string()),
      error: v.optional(v.string()),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    return await getCloudflareProvisioningHandler(ctx, userId, args.workspaceId);
  },
});

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
export const dismissProvisioning = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ dismissed: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    return await dismissProvisioningHandler(ctx, userId, args.workspaceId);
  },
});
