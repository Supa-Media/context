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
 */

import { ConvexError, v } from "convex/values";
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
import type { Id } from "../_generated/dataModel";
import { decryptSecret, encryptSecret, requireKeyset } from "./lib/crypto";
import { recordAudit } from "./lib/audit";
import { consumeRateLimit } from "./lib/rateLimit";
import { redactSecrets } from "./lib/verification";
import { requireWorkspaceAccess, requireWorkspaceRole } from "./lib/workspaceAuth";
import { addressingIsAmbiguous } from "./storage";
import {
  CloudflareApiError,
  type R2Jurisdiction,
  R2_BUCKET_WRITE_PERMISSION_GROUP,
  R2_REGION,
  apiTokenTemplateUrl,
  bucketNameProblem,
  createBucketScopedToken,
  createR2Bucket,
  deriveS3SecretAccessKey,
  isPlausibleAccountId,
  r2Endpoint,
  resolvePermissionGroupId,
  scopedTokenName,
  suggestBucketName,
} from "./lib/cloudflare";

const jurisdictionValidator = v.union(
  v.literal("default"),
  v.literal("eu"),
  v.literal("fedramp"),
);

/**
 * How many buckets one workspace may ask us to create per hour.
 *
 * Every accepted request creates real objects in a customer's cloud account, so
 * an unlimited version is a way to fill somebody's account with buckets using a
 * credential they gave us for one. Keyed by workspace for the same reason
 * `reverifyStorage` is: the workspace is what has storage.
 */
const PROVISION_LIMIT = 5;
const PROVISION_WINDOW_MS = 60 * 60 * 1000;

/** Cap on recorded failure text, matching the bindings' own limit. */
const MAX_RECORDED_ERROR_LENGTH = 300;

/** What the provisioning action reports. Deliberately free of any credential. */
export interface ProvisionOutcome {
  ok: boolean;
  errorCode?: string;
}

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
    const { workspace } = await requireWorkspaceRole(
      ctx,
      args.workspaceId,
      userId,
      "owner",
    );
    const suggestedBucket = suggestBucketName(workspace.slug);
    return {
      url: apiTokenTemplateUrl({ name: scopedTokenName(suggestedBucket) }),
      suggestedBucket,
      accountIdRequired: true,
    };
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
      actorUserId: userId as Id<"users">,
      workspaceId: args.workspaceId,
      credentialSource: args.credential.source,
      encryptedSetupCredential,
      accountId,
      bucket,
      jurisdiction: args.jurisdiction ?? "default",
      locationHint: args.locationHint,
    });
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
  handler: async (ctx, args) => {
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

    if (existing !== null && existing.status === "pending") {
      // One at a time. Two concurrent runs would create two buckets and mint
      // two tokens, and only one of them could end up on the binding — the
      // other would be an orphaned credential in the customer's account that
      // nothing here remembers to clean up.
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
    };

    let provisioningId: Id<"cloudflareProvisioning">;
    if (existing === null) {
      provisioningId = await ctx.db.insert("cloudflareProvisioning", {
        ...fields,
        createdAt: now,
      });
    } else {
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
  },
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
    }),
  ),
  handler: async (ctx, args) => {
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
      jurisdiction: job.jurisdiction,
      locationHint: job.locationHint,
      status: job.status,
    };
  },
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
 *
 * Idempotent in the only sense that matters: it does nothing unless there is a
 * `pending` row with an envelope on it, and the first thing success does is
 * delete that row.
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

    const fail = async (
      errorCode: string,
      message: string,
      detail: string,
    ): Promise<ProvisionOutcome> => {
      const text = detail.length > 0 ? `${message} (Cloudflare: ${detail})` : message;
      const scrubbed = redactSecrets(text, secrets);
      await ctx.runMutation(internal.functions.cloudflare.failProvisioning, {
        workspaceId: args.workspaceId,
        errorCode,
        error:
          scrubbed.length > MAX_RECORDED_ERROR_LENGTH
            ? `${scrubbed.slice(0, MAX_RECORDED_ERROR_LENGTH - 1)}…`
            : scrubbed,
      });
      return { ok: false, errorCode };
    };

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
      return await fail(
        "PROVISION_FAILED",
        "The Cloudflare credential you supplied could not be opened. Start again with a fresh token.",
        "",
      );
    }
    secrets.push(setupCredential);

    try {
      // By name, at runtime. Only the read group's id is published, and a
      // hardcoded id would be a guess about what a token is allowed to do.
      const permissionGroupId = await resolvePermissionGroupId({
        apiToken: setupCredential,
        name: R2_BUCKET_WRITE_PERMISSION_GROUP,
      });

      await createR2Bucket({
        apiToken: setupCredential,
        accountId: job.accountId,
        bucket: job.bucket,
        jurisdiction: job.jurisdiction as R2Jurisdiction,
        locationHint: job.locationHint,
      });

      const minted = await createBucketScopedToken({
        apiToken: setupCredential,
        accountId: job.accountId,
        bucket: job.bucket,
        jurisdiction: job.jurisdiction as R2Jurisdiction,
        permissionGroupId,
        name: scopedTokenName(job.bucket),
      });
      // The minted value is itself a Cloudflare API token. It is never stored:
      // what goes in the row is its SHA-256, which is what R2's S3 API expects
      // as the secret access key and cannot be turned back into a token.
      secrets.push(minted.value);

      const secretAccessKey = await deriveS3SecretAccessKey(minted.value);
      const endpoint = r2Endpoint(job.accountId, job.jurisdiction as R2Jurisdiction);
      const encryptedSecretAccessKey = await encryptSecret(
        secretAccessKey,
        requireKeyset(),
        { workspaceId: args.workspaceId },
      );

      await ctx.runMutation(internal.functions.cloudflare.completeProvisioning, {
        workspaceId: args.workspaceId,
        actorUserId: job.requestedBy,
        endpoint,
        bucket: job.bucket,
        accessKeyId: minted.id,
        encryptedSecretAccessKey,
        // R2's S3 endpoint is path-style and its first host label is the
        // account id, so this is unset for every ordinary bucket — the same
        // thing a manual connect stores. It only has an answer when the bucket
        // is named after the account, which nothing can otherwise resolve.
        forcePathStyle: addressingIsAmbiguous(endpoint, job.bucket) ? true : undefined,
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof CloudflareApiError) {
        return await fail(error.errorCode, error.message, error.detail);
      }
      return await fail(
        "PROVISION_FAILED",
        "Creating the bucket did not finish.",
        String((error as { message?: unknown })?.message ?? ""),
      );
    }
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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
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
    });

    // Distinct from `storage.bound`, which `applyBinding` records: this says a
    // bucket was created in the customer's account by us, which is a different
    // fact and one they should be able to find later. No credential, no token
    // id, no account id beyond what the endpoint already carries.
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: "storage.provisioned",
      details: { provider: "r2", bucket: args.bucket, endpoint: args.endpoint },
    });
    return null;
  },
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
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("cloudflareProvisioning")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (job === null) return null;

    await ctx.db.patch(job._id, {
      status: "failed",
      errorCode: args.errorCode,
      error: args.error,
      // Setting it to `undefined` removes the field. This is the line that
      // makes the credential's lifetime the length of one attempt.
      encryptedSetupCredential: undefined,
      updatedAt: Date.now(),
    });

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: job.requestedBy,
      action: "storage.provision_failed",
      // The code only. `error` may carry provider prose and belongs on the row
      // the owner reads, not in an event stream several people can read.
      details: { provider: "r2", bucket: job.bucket, errorCode: args.errorCode },
    });
    return null;
  },
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
    await requireWorkspaceAccess(ctx, args.workspaceId, userId);

    const job = await ctx.db
      .query("cloudflareProvisioning")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
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
    await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

    const job = await ctx.db
      .query("cloudflareProvisioning")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (job === null) return { dismissed: false };

    await ctx.db.delete(job._id);
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "storage.provision_dismissed",
      details: { provider: "r2", bucket: job.bucket, fromStatus: job.status },
    });
    return { dismissed: true };
  },
});
