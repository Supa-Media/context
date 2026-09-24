import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "../_generated/server";
import { decryptSecret, encryptSecret, requireKeyset } from "./lib/crypto";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import {
  reconcileMigrationPage,
  type MigrationStore,
} from "./lib/managedMigration";
import { requireUserId } from "./lib/managedProvisioningFns/helpers";
import {
  CloudflareApiError,
  createBucketScopedToken,
  createR2Bucket,
  deriveS3SecretAccessKey,
  emptyAndDeleteR2Bucket,
  r2Endpoint,
  R2_CREDENTIAL_SETTLE_MS,
  resolvePermissionGroupId,
  revokeApiToken,
  scopedTokenName,
} from "./lib/cloudflare";
import {
  MANAGED_R2_API_TOKEN_SECRET,
  managedAccountId,
  managedBucketName,
} from "./lib/managedStorage";
import {
  provisioningStandingHandler,
  recordManagedProvisioningHandler,
} from "./lib/managedProvisioningFns/standing";
import {
  beginManagedStorageMigrationHandler,
  resumeManagedStorageMigrationHandler,
} from "./lib/managedProvisioningFns/migrationBegin";
import { failManagedStorageMigrationHandler } from "./lib/managedProvisioningFns/migrationFail";
import { migrationForCopyHandler } from "./lib/managedProvisioningFns/migrationRead";
import { recordMigrationPageHandler } from "./lib/managedProvisioningFns/migrationPage";
import { finishManagedStorageMigrationHandler } from "./lib/managedProvisioningFns/migrationFinish";
import {
  finishAwaitManagedTargetReady,
  probeManagedTarget,
} from "./lib/managedProvisioningFns/targetReady";
import { completeManagedProvisioningHandler } from "./lib/managedProvisioningFns/complete";
import { retryManagedProvisioningHandler } from "./lib/managedProvisioningFns/retry";
import {
  MANAGED_STORAGE_SETTLE_POLL_MS,
  MIGRATION_OBJECT_BYTE_CAP,
  MIGRATION_PAGE_SIZE,
  MIGRATION_WAVE_BYTE_BUDGET,
  MIGRATION_WAVE_WIDTH,
  R2_BUCKET_WRITE_PERMISSION_GROUP,
  TERMINAL_MIGRATION_ERRORS,
  type ManagedProvisionError,
} from "./lib/managedProvisioningFns/constants";

/**
 * Tear down resources belonging to the dedicated CUJ account only.
 * The mutation that schedules this proves the owner identity; this action
 * re-proves the deterministic bucket name so malformed args cannot widen it.
 */
export const deleteManagedTestResources = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    bucket: v.string(),
    tokenId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.bucket !== managedBucketName(args.workspaceId)) {
      throw new Error("Refusing to delete a bucket outside the managed test workspace boundary.");
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
    // Revoke even when emptying fails: once the account metadata is gone,
    // leaving a standing bucket credential is strictly worse than leaving an
    // unreachable bucket for an operator cleanup.
    const revoked = await revokeApiToken({ apiToken, accountId, tokenId: args.tokenId });
    if (bucketFailure !== undefined) throw bucketFailure;
    if (!revoked) throw new Error("Managed bucket was deleted but its scoped token could not be revoked.");
    return null;
  },
});

/**
 * Creating the bucket a Premium customer paid for.
 *
 * ## What this is, in one line
 *
 * The same three Cloudflare calls the BYO path makes — create a bucket, mint a
 * key scoped to it, store what a pasted binding stores — against **our**
 * account instead of the customer's, using an operator credential instead of
 * one they handed us for ninety seconds.
 *
 * Downstream nothing can tell the two apart, and that is the point: the
 * gateway, the storage adapter and the privacy engine see one shape of binding
 * and have no idea who is paying. `storage-and-credentials.md` states it as a
 * requirement; this file is where it has to be kept.
 *
 * ## Adopting is the correct behaviour here, and it is not in the BYO path
 *
 * A taken bucket name on the customer's own account is a question — it might
 * be *their* bucket, and `provisionCloudflareStorage` asks Cloudflare when it
 * was created before touching it. In our account there is no such doubt: the
 * name is `ctx-<workspace id>`, the id is immutable and unguessable, and only
 * this function creates buckets there. So a bucket that already exists for
 * this workspace **is** this workspace's, and the run adopts it.
 *
 * That is what makes retry safe, which is what the screen after a failure
 * promises in so many words: trying again cannot create a second copy of
 * anything. Get this wrong in the other direction — a fresh bucket per attempt
 * — and a customer who pressed twice has two buckets, one of which their notes
 * are not in.
 *
 * ## The credential split, and why it is not one value
 *
 * The **account id** is an identifier and lives in an environment variable
 * (`MANAGED_R2_ACCOUNT_ID`); the **API token** is a credential and lives in
 * `appSecrets`, encrypted at rest and rotatable from the staff console, which
 * is where `SEARCH_D1_API_TOKEN` lives for the same reason. Guards on public
 * paths need the id and may never reach a decryptable secret
 * (`__tests__/structure.test.ts` fails any public function whose call graph
 * reaches `decryptSecret`), and a rotation must not make those guards fail
 * open. One value could not do both jobs.
 *
 * ## NOTHING HERE HAS BEEN RUN AGAINST CLOUDFLARE
 *
 * No managed account id and no operator token exist in the environment this
 * was written in, so every call shape below follows Cloudflare's published API
 * and the BYO path that has been run against a real account — and the tests
 * drive them against a stubbed socket. The live contract is unverified. Treat
 * the first real run as the first test of this file, and check three things
 * before believing it: that the token may create a bucket **and** mint a
 * bucket-scoped token (open question 3 in `lib/cloudflare.ts` — an OAuth grant
 * cannot do the second), that adoption returns the bucket rather than an
 * error, and that the stored key opens the bucket through the ordinary S3
 * path.
 *
 * Internal, and reached only by a schedule edge — from the webhook that turns a
 * plan active, and from the owner's retry. "Scheduling is not calling" is what
 * keeps the public mutation that starts it from being a path to the operator
 * token it opens.
 *
 * ## Layout of this module
 *
 * Every export below is a thin Convex registration whose handler delegates to
 * `lib/managedProvisioningFns/`, where the logic (and its comments) actually
 * live — **except the `decryptSecret` calls in `awaitManagedTargetReady` and
 * `runManagedStorageMigration`**, which stay here:
 * `__tests__/structure.test.ts` enumerates exactly which modules may import
 * `decryptSecret` at all, and this file is one of them. Everything each of
 * those functions does with the opened secret is a lib helper that takes it
 * as a plain argument and never imports the decrypt itself.
 */
export const provisionManagedStorage = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ ok: v.boolean(), errorCode: v.optional(v.string()) }),
  handler: async (ctx, args): Promise<{ ok: boolean; errorCode?: string }> => {
    const fail = async (errorCode: ManagedProvisionError) => {
      await ctx.runMutation(
        internal.functions.managedProvisioning.recordManagedProvisioning,
        { workspaceId: args.workspaceId, state: "failed", errorCode },
      );
      return { ok: false, errorCode };
    };

    /*
      Every precondition is re-read here rather than trusted from the caller.
      The webhook that scheduled this may be minutes old, the subscription may
      have been cancelled since, and a second run may have already finished —
      and this function mints a credential, which is not a thing to do on a
      stale premise.
    */
    const standing = await ctx.runQuery(
      internal.functions.managedProvisioning.provisioningStanding,
      { workspaceId: args.workspaceId },
    );
    if (standing === null || standing.ownerId === null) return { ok: false };
    if (!standing.entitled) return await fail("NOT_ENTITLED");
    if (standing.bindingIsManaged) {
      await ctx.runMutation(
        internal.functions.managedProvisioning.recordManagedProvisioning,
        { workspaceId: args.workspaceId, state: "ready" },
      );
      return { ok: true };
    }
    await ctx.runMutation(
      internal.functions.managedProvisioning.recordManagedProvisioning,
      { workspaceId: args.workspaceId, state: "running" },
    );
    if (standing.migrationStatus !== undefined) {
      const resumed: boolean = await ctx.runMutation(
        internal.functions.managedProvisioning.resumeManagedStorageMigration,
        { workspaceId: args.workspaceId, actorUserId: standing.ownerId },
      );
      if (!resumed) return await fail("PROVISION_FAILED");
      await ctx.scheduler.runAfter(
        0,
        internal.functions.managedProvisioning.awaitManagedTargetReady,
        {
          workspaceId: args.workspaceId,
          retryUntil: Date.now() + R2_CREDENTIAL_SETTLE_MS,
        },
      );
      return { ok: true };
    }

    let accountId: string | null;
    try {
      accountId = managedAccountId();
    } catch {
      // Set but malformed — an operator error, and the customer's screen says
      // this deployment cannot do it rather than blaming Cloudflare.
      return await fail("NOT_CONFIGURED");
    }
    const apiToken = await ctx.runAction(
      internal.functions.admin.readIntegrationSecret,
      {
        name: MANAGED_R2_API_TOKEN_SECRET,
      },
    );
    if (
      accountId === null ||
      typeof apiToken !== "string" ||
      apiToken.length === 0
    ) {
      return await fail("NOT_CONFIGURED");
    }

    const bucket = managedBucketName(args.workspaceId);

    try {
      const permissionGroupId = await resolvePermissionGroupId({
        apiToken,
        accountId,
        name: R2_BUCKET_WRITE_PERMISSION_GROUP,
      });

      try {
        await createR2Bucket({
          apiToken,
          accountId,
          bucket,
          jurisdiction: "default",
        });
      } catch (error) {
        /*
          A taken name in our own account is this workspace's own bucket — see
          the header. Adopting is what makes a retry safe, and safe retry is
          what the screen after a failure promises in so many words.
        */
        if (
          !(error instanceof CloudflareApiError) ||
          error.errorCode !== "BUCKET_NAME_TAKEN"
        ) {
          throw error;
        }
      }

      const minted = await createBucketScopedToken({
        apiToken,
        accountId,
        bucket,
        jurisdiction: "default",
        permissionGroupId,
        name: scopedTokenName(bucket),
      });

      /*
        The minted value is itself a Cloudflare API token and is never stored:
        what goes in the row is its SHA-256, which is what R2's S3 API expects
        as the secret access key and cannot be turned back into a token. The
        *operator* token is never stored here either — it lives in `appSecrets`
        and was opened for this call alone.
      */
      const secretAccessKey = await deriveS3SecretAccessKey(minted.value);
      const encryptedSecretAccessKey = await encryptSecret(
        secretAccessKey,
        requireKeyset(),
        {
          workspaceId: args.workspaceId,
        },
      );

      if (standing.bindingId === null) {
        await ctx.runMutation(
          internal.functions.managedProvisioning.completeManagedProvisioning,
          {
            workspaceId: args.workspaceId,
            actorUserId: standing.ownerId,
            endpoint: r2Endpoint(accountId, "default"),
            bucket,
            accessKeyId: minted.id,
            encryptedSecretAccessKey,
          },
        );
      } else {
        await ctx.runMutation(
          internal.functions.managedProvisioning.beginManagedStorageMigration,
          {
            workspaceId: args.workspaceId,
            actorUserId: standing.ownerId,
            sourceBindingId: standing.bindingId,
            endpoint: r2Endpoint(accountId, "default"),
            bucket,
            accessKeyId: minted.id,
            encryptedSecretAccessKey,
          },
        );
      }
      return { ok: true };
    } catch (error) {
      /*
        Cloudflare's own text is deliberately not recorded. It can name the
        account, and this error code reaches a customer's screen — where what
        they need is our sentence and the next safe action, not a provider
        message about infrastructure that is not theirs. The detail goes to the
        structured log, which is ours to read.
      */
      console.error("managed_storage.provision_failed", {
        workspaceId: args.workspaceId,
        stage:
          error instanceof CloudflareApiError ? error.errorCode : "unknown",
      });
      return await fail(
        error instanceof CloudflareApiError
          ? "CLOUDFLARE_REFUSED"
          : "PROVISION_FAILED",
      );
    }
  },
});

/**
 * What the action needs to know before it mints anything.
 *
 * One query rather than three reads inside the action, so the preconditions
 * are asked as one consistent picture rather than three that can disagree.
 */
export const provisioningStanding = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({
      entitled: v.boolean(),
      bindingId: v.union(v.null(), v.id("storageBindings")),
      migrationStatus: v.optional(
        v.union(v.literal("copying"), v.literal("failed")),
      ),
      bindingIsManaged: v.boolean(),
      /**
       * Who this is being done for.
       *
       * `applyBinding` re-authorizes its actor as an owner, and that check is
       * worth keeping rather than routing around — so the managed path names
       * the owner it is provisioning for instead of writing the row itself. A
       * context with no owner (mid-deletion) yields `null` and nothing is
       * written.
       */
      ownerId: v.union(v.null(), v.id("users")),
    }),
  ),
  handler: async (ctx, args) => provisioningStandingHandler(ctx, args),
});

/** Where an attempt got to. Written by the action, read by the console. */
export const recordManagedProvisioning = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    state: v.union(
      v.literal("running"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    errorCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => recordManagedProvisioningHandler(ctx, args),
});

/** Park the managed destination without changing which storage is live. */
export const beginManagedStorageMigration = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    sourceBindingId: v.id("storageBindings"),
    endpoint: v.string(),
    bucket: v.string(),
    accessKeyId: v.string(),
    encryptedSecretAccessKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => beginManagedStorageMigrationHandler(ctx, args),
});

/**
 * Prove the managed bucket answers, then start the copy.
 *
 * ## Why a wait, rather than just letting the copy fail and be retried
 *
 * Because "retry" here is a person reading a screen that says their upgrade
 * did not work. A newly minted bucket-scoped token takes a moment to become
 * usable at the S3 endpoint, which is not a failure and must not be reported
 * as one — every managed upgrade would hit it, and every one of them would be
 * told the copy stopped and offered a button that then worked first time.
 *
 * So this polls the target until it is reachable *and* writable, and only then
 * hands over to the walk. Nothing is moved and nothing is switched while it
 * waits: the customer's own storage stays bound and serving throughout, and a
 * target that never answers inside the window fails with a code of ours rather
 * than hanging.
 *
 * See `lib/managedProvisioningFns/targetReady.ts` for the probe itself and
 * what happens once it has answered.
 */
export const awaitManagedTargetReady = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    /** Absolute deadline. Past it, an unready bucket is a failure. */
    retryUntil: v.number(),
  },
  returns: v.object({ ready: v.boolean() }),
  handler: async (ctx, args): Promise<{ ready: boolean }> => {
    const migration: Doc<"managedStorageMigrations"> | null =
      await ctx.runQuery(
        internal.functions.managedProvisioning.migrationForCopy,
        { workspaceId: args.workspaceId },
      );
    // Cancelled, already finished, or failed by something else. Not ours.
    if (migration === null || migration.status !== "copying") {
      return { ready: false };
    }

    let ready = false;
    try {
      const secretAccessKey = await decryptSecret(
        migration.encryptedTargetSecretAccessKey,
        requireKeyset(),
        { workspaceId: args.workspaceId },
      );
      ready = await probeManagedTarget(migration, secretAccessKey);
    } catch {
      // An envelope that will not open, or a store that cannot be built. Both
      // resolve the same way as an unready bucket: try again until the
      // deadline, then say so.
      ready = false;
    }

    return await finishAwaitManagedTargetReady(ctx, args, migration, ready);
  },
});

/** Resume the parked destination; a newly connected source restarts its scan. */
export const resumeManagedStorageMigration = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => resumeManagedStorageMigrationHandler(ctx, args),
});

/** Record a closed error code while keeping the source binding live. */
export const failManagedStorageMigration = internalMutation({
  args: { workspaceId: v.id("workspaces"), errorCode: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => failManagedStorageMigrationHandler(ctx, args),
});

/** The encrypted destination and progress, visible only to the copy action. */
export const migrationForCopy = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<Doc<"managedStorageMigrations"> | null> =>
    migrationForCopyHandler(ctx, args),
});

/** Advance exactly the page the action read; stale duplicate pages are no-ops. */
export const recordMigrationPage = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    expectedCursor: v.optional(v.string()),
    nextCursor: v.optional(v.string()),
    copied: v.number(),
    changes: v.number(),
    processed: v.number(),
  },
  returns: v.object({ applied: v.boolean(), cutover: v.boolean() }),
  handler: async (ctx, args) => recordMigrationPageHandler(ctx, args),
});

/** Atomically replace only the exact source binding the copy began from. */
export const finishManagedStorageMigration = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ cutover: v.boolean() }),
  handler: async (ctx, args) => finishManagedStorageMigrationHandler(ctx, args),
});

/** Count or reconcile one resumable page, then schedule the next one. */
export const runManagedStorageMigration = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    /**
     * Deadline for the *current run of failures*, not for the migration.
     *
     * Set when a page first fails and carried across the retries of that one
     * page; a page that succeeds schedules its successor without it, so the
     * window starts again. A copy of a thousand objects is therefore not on a
     * two-minute clock — only an unbroken streak of failures is.
     */
    retryUntil: v.optional(v.number()),
  },
  returns: v.object({ copied: v.number(), complete: v.boolean() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ copied: number; complete: boolean }> => {
    const migration: Doc<"managedStorageMigrations"> | null =
      await ctx.runQuery(
        internal.functions.managedProvisioning.migrationForCopy,
        { workspaceId: args.workspaceId },
      );
    if (migration === null || migration.status !== "copying") {
      return { copied: 0, complete: false };
    }
    try {
      const sourceCredential = await ctx.runAction(
        internal.functions.storage.getBindingForGateway,
        { workspaceId: args.workspaceId },
      );
      if (sourceCredential === null) throw new Error("SOURCE_UNAVAILABLE");

      const secretAccessKey = await decryptSecret(
        migration.encryptedTargetSecretAccessKey,
        requireKeyset(),
        { workspaceId: args.workspaceId },
      );
      const source = storeForBinding(sourceCredential, undefined, { rawObjects: true });
      const target = storeForBinding({
        provider: "r2",
        endpoint: migration.targetEndpoint,
        region: "auto",
        bucket: migration.targetBucket,
        accessKeyId: migration.targetAccessKeyId,
        secretAccessKey,
        capabilities: { conditionalWrite: true },
        status: "connected",
      }, undefined, { rawObjects: true });
      const listingStore =
        migration.phase === "verify_target" ? target : source;
      const page = await listingStore.list({
        cursor: migration.cursor,
        limit: MIGRATION_PAGE_SIZE,
      });
      let copied = 0;
      let changes = 0;
      // The census only counts what it lists; it opens no object at all.
      if (migration.phase !== "count") {
        // Ahead of the walk rather than inside it, so a page carrying an object
        // too large to move fails before any of that page is reconciled. Inside
        // the waves this would depend on which wave the object landed in.
        for (const object of page.objects) {
          if (
            typeof object.size === "number" &&
            object.size > MIGRATION_OBJECT_BYTE_CAP
          ) {
            throw new Error("OBJECT_TOO_LARGE");
          }
        }
        const result = await reconcileMigrationPage({
          source: source as unknown as MigrationStore,
          target: target as unknown as MigrationStore,
          objects: page.objects,
          listedFromTarget: migration.phase === "verify_target",
          byteCap: MIGRATION_OBJECT_BYTE_CAP,
          maxWidth: MIGRATION_WAVE_WIDTH,
          byteBudget: MIGRATION_WAVE_BYTE_BUDGET,
        });
        copied = result.copied;
        changes = result.changes;
      }
      const progress = await ctx.runMutation(
        internal.functions.managedProvisioning.recordMigrationPage,
        {
          workspaceId: args.workspaceId,
          expectedCursor: migration.cursor,
          nextCursor: page.truncated ? page.cursor : undefined,
          copied,
          changes,
          processed: page.objects.length,
        },
      );
      if (!progress.applied) return { copied: 0, complete: false };
      if (progress.cutover) {
        const result: { cutover: boolean } = await ctx.runMutation(
          internal.functions.managedProvisioning.finishManagedStorageMigration,
          { workspaceId: args.workspaceId },
        );
        return { copied, complete: result.cutover };
      }
      // Deliberately without `retryUntil`: this page landed, so the next one
      // gets a full window of its own rather than inheriting a spent clock.
      await ctx.scheduler.runAfter(
        0,
        internal.functions.managedProvisioning.runManagedStorageMigration,
        { workspaceId: args.workspaceId },
      );
      return { copied, complete: false };
    } catch (error) {
      const errorCode =
        error instanceof Error &&
        ["SOURCE_UNAVAILABLE", "OBJECT_TOO_LARGE", "VERIFY_FAILED"].includes(
          error.message,
        )
          ? error.message
          : "COPY_FAILED";
      console.error("managed_storage.migration_failed", {
        workspaceId: args.workspaceId,
        phase: migration.phase,
        errorCode,
      });
      /*
        A page that failed is not a migration that failed.

        The target is a bucket minted minutes ago, the source is somebody
        else's storage, and both are reached over the network — so a single
        refused request is the expected kind of event, not the end of the job.
        Ending it there is what put "the copy stopped" in front of a customer
        whose retry then worked without changing anything, and on a long copy
        it would throw away a walk that was most of the way done.

        `VERIFY_FAILED` is retried for the same reason: a read-back that does
        not match a write made moments ago is far likelier to be a bucket that
        has not settled than a bucket that corrupts what it is given. What is
        *not* retried is anything that would answer identically forever — the
        migration's own preconditions, and an object too large to move.

        Nothing is written while retrying: the row stays `copying` at the cursor
        it already had, the plan stays as it was, and the source binding is
        untouched. The customer sees the copy still running, because it is.
      */
      const deadline =
        args.retryUntil ?? Date.now() + R2_CREDENTIAL_SETTLE_MS;
      const remaining = deadline - Date.now();
      if (!TERMINAL_MIGRATION_ERRORS.has(errorCode) && remaining > 0) {
        const delay = Math.min(MANAGED_STORAGE_SETTLE_POLL_MS, remaining);
        await ctx.scheduler.runAfter(
          delay,
          internal.functions.managedProvisioning.runManagedStorageMigration,
          { workspaceId: args.workspaceId, retryUntil: deadline },
        );
        return { copied: 0, complete: false };
      }
      await ctx.runMutation(
        internal.functions.managedProvisioning.failManagedStorageMigration,
        { workspaceId: args.workspaceId, errorCode },
      );
      return { copied: 0, complete: false };
    }
  },
});

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
export const completeManagedProvisioning = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    endpoint: v.string(),
    bucket: v.string(),
    accessKeyId: v.string(),
    encryptedSecretAccessKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => completeManagedProvisioningHandler(ctx, args),
});

/**
 * Try again, from the screen that told them it had not worked.
 *
 * Owner-only, and it schedules rather than calls — this is a public mutation
 * and the action it starts opens a credential. Safe to press twice: the run it
 * schedules adopts the bucket it may already have created.
 */
export const retryManagedProvisioning = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await retryManagedProvisioningHandler(ctx, userId, args.workspaceId);
  },
});

/**
 * Start provisioning because a payment just landed.
 *
 * Called from the webhook's own transaction when a plan turns active with
 * managed storage chosen and no storage bound. Separate from the retry so the
 * webhook path has no authorization to perform — it is not acting for a user.
 */
export async function startManagedProvisioning(
  ctx: {
    db: unknown;
    scheduler: {
      runAfter: (ms: number, fn: unknown, args: unknown) => Promise<unknown>;
    };
  },
  workspaceId: Id<"workspaces">,
): Promise<void> {
  await ctx.scheduler.runAfter(
    0,
    internal.functions.managedProvisioning.provisionManagedStorage,
    { workspaceId },
  );
}
