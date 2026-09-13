import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { QueryCtx } from "../_generated/server";
import { requireWorkspaceRole } from "./lib/workspaceAuth";
import { decryptSecret, encryptSecret, requireKeyset } from "./lib/crypto";
import { recordAudit } from "./lib/audit";
import {
  CloudflareApiError,
  createBucketScopedToken,
  createR2Bucket,
  emptyAndDeleteR2Bucket,
  deriveS3SecretAccessKey,
  r2Endpoint,
  resolvePermissionGroupId,
  scopedTokenName,
  revokeApiToken,
} from "./lib/cloudflare";
import {
  MANAGED_R2_API_TOKEN_SECRET,
  managedAccountId,
  managedBucketName,
} from "./lib/managedStorage";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import {
  reconcileMigrationObject,
  type MigrationStore,
} from "./lib/managedMigration";

const MIGRATION_PAGE_SIZE = 25;
const MIGRATION_OBJECT_BYTE_CAP = 25 * 1024 * 1024;
const MANAGED_STORAGE_SETUP_TIMEOUT_MS = 2 * 60 * 1000;

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
 */

/** Ours, from a closed set. Never Cloudflare's text, which can name an account. */
export type ManagedProvisionError =
  | "NOT_CONFIGURED"
  | "NOT_ENTITLED"
  | "ALREADY_BOUND"
  | "CLOUDFLARE_REFUSED"
  | "PROVISION_FAILED";

/**
 * The R2 permission group a bucket-scoped token needs, by name.
 *
 * Resolved at runtime rather than hardcoded, exactly as the BYO path does it:
 * only the read group's id is published, and a hardcoded id would be a guess
 * about what a token is allowed to do.
 */
const R2_BUCKET_WRITE_PERMISSION_GROUP = "Workers R2 Storage Bucket Item Write";

async function requireUserId(ctx: QueryCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({
      code: "NOT_AUTHENTICATED",
      message: "Sign in first.",
    });
  }
  return userId;
}

/**
 * Make the bucket, or record why not.
 *
 * Internal, and reached only by a schedule edge — from the webhook that turns a
 * plan active, and from the owner's retry. "Scheduling is not calling" is what
 * keeps the public mutation that starts it from being a path to the operator
 * token it opens.
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
        internal.functions.managedProvisioning.runManagedStorageMigration,
        { workspaceId: args.workspaceId },
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
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (workspace === null) return null;
    const plan = await ctx.db
      .query("workspacePlans")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    const migration = await ctx.db
      .query("managedStorageMigrations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    const owner = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    return {
      // Both halves: chosen *and* paying. `activeEntitlements` is the one place
      // that computes it, and this asks the same question the same way.
      entitled: plan?.managedStorage === true && plan.status === "active",
      bindingId: binding?._id ?? null,
      migrationStatus: migration?.status,
      bindingIsManaged: binding?.bucket === managedBucketName(args.workspaceId),
      ownerId: owner.find((member) => member.role === "owner")?.userId ?? null,
    };
  },
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
  handler: async (ctx, args) => {
    const plan = await ctx.db
      .query("workspacePlans")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (plan === null) return null;
    await ctx.db.patch(plan._id, {
      managedProvisioning: args.state,
      managedProvisioningError: args.errorCode,
      managedProvisioningAt: Date.now(),
      updatedAt: Date.now(),
    });
    return null;
  },
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
  handler: async (ctx, args) => {
    await requireWorkspaceRole(
      ctx,
      args.workspaceId,
      args.actorUserId,
      "owner",
    );
    const current = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (current?._id !== args.sourceBindingId) return null;

    const now = Date.now();
    const existing = await ctx.db
      .query("managedStorageMigrations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    const fields = {
      workspaceId: args.workspaceId,
      sourceBindingId: args.sourceBindingId,
      targetEndpoint: args.endpoint,
      targetBucket: args.bucket,
      targetAccessKeyId: args.accessKeyId,
      encryptedTargetSecretAccessKey: args.encryptedSecretAccessKey,
      status: "copying" as const,
      phase: "count" as const,
      cursor: undefined,
      objectsCopied: 0,
      objectsTotal: undefined,
      objectsProcessedInPhase: 0,
      changesInPass: 0,
      readyToCutover: false,
      errorCode: undefined,
      startedBy: args.actorUserId,
      updatedAt: now,
    };
    if (existing === null) {
      await ctx.db.insert("managedStorageMigrations", {
        ...fields,
        createdAt: now,
      });
    } else if (existing.sourceBindingId === args.sourceBindingId) {
      // A retry resumes the destination it already created. Do not reset the
      // cursor or replace the credential with a second minted token.
      await ctx.db.patch(existing._id, {
        status: "copying",
        errorCode: undefined,
        readyToCutover: false,
        updatedAt: now,
      });
    }
    await ctx.scheduler.runAfter(
      0,
      internal.functions.managedProvisioning.runManagedStorageMigration,
      { workspaceId: args.workspaceId },
    );
    return null;
  },
});

/** Resume the parked destination; a newly connected source restarts its scan. */
export const resumeManagedStorageMigration = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("managedStorageMigrations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (row === null) return false;
    const current = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (current === null) return false;
    const sourceChanged = current._id !== row.sourceBindingId;
    await ctx.db.patch(row._id, {
      sourceBindingId: current._id,
      startedBy: args.actorUserId,
      status: "copying",
      errorCode: undefined,
      readyToCutover: false,
      ...(sourceChanged
        ? {
            phase: "count" as const,
            cursor: undefined,
            objectsCopied: 0,
            objectsTotal: undefined,
            objectsProcessedInPhase: 0,
            changesInPass: 0,
          }
        : {}),
      updatedAt: Date.now(),
    });
    return true;
  },
});

/** Record a closed error code while keeping the source binding live. */
export const failManagedStorageMigration = internalMutation({
  args: { workspaceId: v.id("workspaces"), errorCode: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("managedStorageMigrations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (row !== null && row.status === "copying") {
      await ctx.db.patch(row._id, {
        status: "failed",
        errorCode: args.errorCode,
        updatedAt: Date.now(),
      });
    }
    const plan = await ctx.db
      .query("workspacePlans")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (plan !== null) {
      await ctx.db.patch(plan._id, {
        managedProvisioning: "failed",
        managedProvisioningError: args.errorCode,
        managedProvisioningAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

/** The encrypted destination and progress, visible only to the copy action. */
export const migrationForCopy = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<Doc<"managedStorageMigrations"> | null> =>
    await ctx.db
      .query("managedStorageMigrations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique(),
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
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("managedStorageMigrations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (
      row === null ||
      row.status !== "copying" ||
      row.readyToCutover === true ||
      row.cursor !== args.expectedCursor ||
      !Number.isInteger(args.copied) ||
      args.copied < 0 ||
      !Number.isInteger(args.changes) ||
      args.changes < 0 ||
      !Number.isInteger(args.processed) ||
      args.processed < 0
    ) {
      return { applied: false, cutover: false };
    }
    if (
      args.nextCursor !== undefined &&
      args.nextCursor === args.expectedCursor
    ) {
      await ctx.db.patch(row._id, {
        status: "failed",
        errorCode: "CURSOR_STALLED",
        updatedAt: Date.now(),
      });
      return { applied: false, cutover: false };
    }
    const objectsProcessedInPhase =
      (row.objectsProcessedInPhase ?? 0) + args.processed;
    if (row.phase === "count") {
      if (args.copied !== 0 || args.changes !== 0) {
        return { applied: false, cutover: false };
      }
      if (args.nextCursor !== undefined) {
        await ctx.db.patch(row._id, {
          cursor: args.nextCursor,
          objectsProcessedInPhase,
          updatedAt: Date.now(),
        });
        return { applied: true, cutover: false };
      }
      await ctx.db.patch(row._id, {
        phase: "copy",
        cursor: undefined,
        objectsTotal: objectsProcessedInPhase,
        objectsProcessedInPhase: 0,
        changesInPass: 0,
        updatedAt: Date.now(),
      });
      return { applied: true, cutover: false };
    }
    const changesInPass = row.changesInPass + args.changes;
    if (args.nextCursor === undefined) {
      if (row.phase === "copy") {
        await ctx.db.patch(row._id, {
          phase: "verify_source",
          cursor: undefined,
          objectsCopied: row.objectsCopied + args.copied,
          // The source is allowed to change while the migration runs. The
          // completed walk is a fresher denominator than the census that
          // preceded it, whether files were added or removed.
          // An in-flight migration created by the previous release has no
          // census. Its processed count starts at the page after its saved
          // cursor, so treating that partial remainder as a total would be a
          // lie; keep the denominator absent and use the legacy checked count.
          objectsTotal:
            row.objectsTotal === undefined
              ? undefined
              : objectsProcessedInPhase,
          objectsProcessedInPhase: 0,
          changesInPass: 0,
          updatedAt: Date.now(),
        });
        return { applied: true, cutover: false };
      }
      if (row.phase === "verify_source") {
        await ctx.db.patch(row._id, {
          phase: "verify_target",
          cursor: undefined,
          objectsCopied: row.objectsCopied + args.copied,
          objectsTotal:
            row.objectsTotal === undefined
              ? undefined
              : objectsProcessedInPhase,
          objectsProcessedInPhase: 0,
          changesInPass,
          updatedAt: Date.now(),
        });
        return { applied: true, cutover: false };
      }
      if (changesInPass > 0) {
        await ctx.db.patch(row._id, {
          phase: "verify_source",
          cursor: undefined,
          objectsCopied: row.objectsCopied + args.copied,
          objectsProcessedInPhase: 0,
          changesInPass: 0,
          readyToCutover: false,
          updatedAt: Date.now(),
        });
        return { applied: true, cutover: false };
      }
      await ctx.db.patch(row._id, {
        readyToCutover: true,
        objectsProcessedInPhase,
        updatedAt: Date.now(),
      });
      return { applied: true, cutover: true };
    }
    await ctx.db.patch(row._id, {
      cursor: args.nextCursor,
      objectsCopied: row.objectsCopied + args.copied,
      objectsProcessedInPhase,
      changesInPass,
      updatedAt: Date.now(),
    });
    return { applied: true, cutover: false };
  },
});

/** Atomically replace only the exact source binding the copy began from. */
export const finishManagedStorageMigration = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ cutover: v.boolean() }),
  handler: async (ctx, args) => {
    const migration = await ctx.db
      .query("managedStorageMigrations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    const current = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (
      migration === null ||
      migration.status !== "copying" ||
      migration.phase !== "verify_target" ||
      migration.readyToCutover !== true ||
      current?._id !== migration.sourceBindingId
    ) {
      if (migration !== null) {
        await ctx.db.patch(migration._id, {
          status: "failed",
          errorCode: "SOURCE_CHANGED",
          updatedAt: Date.now(),
        });
      }
      return { cutover: false };
    }

    await ctx.runMutation(internal.functions.storage.applyBinding, {
      workspaceId: args.workspaceId,
      actorUserId: migration.startedBy,
      provider: "r2",
      endpoint: migration.targetEndpoint,
      region: "auto",
      bucket: migration.targetBucket,
      accessKeyId: migration.targetAccessKeyId,
      encryptedSecretAccessKey: migration.encryptedTargetSecretAccessKey,
    });
    await ctx.db.delete(migration._id);
    const plan = await ctx.db
      .query("workspacePlans")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (plan !== null) {
      await ctx.db.patch(plan._id, {
        managedProvisioning: "ready",
        managedProvisioningError: undefined,
        managedProvisioningAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: migration.startedBy,
      action: "storage.managed_migrated",
      details: { objectsCopied: migration.objectsCopied },
    });
    return { cutover: true };
  },
});

/** Count or reconcile one resumable page, then schedule the next one. */
export const runManagedStorageMigration = internalAction({
  args: { workspaceId: v.id("workspaces") },
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
      const source = storeForBinding(sourceCredential);
      const target = storeForBinding({
        provider: "r2",
        endpoint: migration.targetEndpoint,
        region: "auto",
        bucket: migration.targetBucket,
        accessKeyId: migration.targetAccessKeyId,
        secretAccessKey,
        capabilities: { conditionalWrite: true },
        status: "connected",
      });
      const listingStore =
        migration.phase === "verify_target" ? target : source;
      const page = await listingStore.list({
        cursor: migration.cursor,
        limit: MIGRATION_PAGE_SIZE,
      });
      let copied = 0;
      let changes = 0;
      for (const object of page.objects) {
        if (migration.phase === "count") continue;
        if (
          typeof object.size === "number" &&
          object.size > MIGRATION_OBJECT_BYTE_CAP
        ) {
          throw new Error("OBJECT_TOO_LARGE");
        }
        const result = await reconcileMigrationObject({
          source: source as unknown as MigrationStore,
          target: target as unknown as MigrationStore,
          key: object.key,
          listedFromTarget: migration.phase === "verify_target",
          byteCap: MIGRATION_OBJECT_BYTE_CAP,
        });
        copied += result.copied;
        changes += result.changes;
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
  handler: async (ctx, args) => {
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
        verificationRetryUntil: Date.now() + MANAGED_STORAGE_SETUP_TIMEOUT_MS,
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
  },
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
    await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");
    const plan = await ctx.db
      .query("workspacePlans")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (plan === null || plan.managedStorage !== true) {
      throw new ConvexError({
        code: "NOT_ENTITLED",
        message: "This context is not set up for storage we keep.",
      });
    }
    await ctx.db.patch(plan._id, {
      managedProvisioning: "running",
      managedProvisioningError: undefined,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(
      0,
      internal.functions.managedProvisioning.provisionManagedStorage,
      { workspaceId: args.workspaceId },
    );
    return null;
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
