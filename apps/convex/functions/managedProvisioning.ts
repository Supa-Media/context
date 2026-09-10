import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { QueryCtx } from "../_generated/server";
import { requireWorkspaceRole } from "./lib/workspaceAuth";
import { encryptSecret, requireKeyset } from "./lib/crypto";
import { recordAudit } from "./lib/audit";
import {
  CloudflareApiError,
  createBucketScopedToken,
  createR2Bucket,
  deriveS3SecretAccessKey,
  r2Endpoint,
  resolvePermissionGroupId,
  scopedTokenName,
} from "./lib/cloudflare";
import { MANAGED_R2_API_TOKEN_SECRET, managedAccountId, managedBucketName } from "./lib/managedStorage";

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
    throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Sign in first." });
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
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; errorCode?: string }> => {
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
    if (standing.hasBinding) {
      /*
        Already storage here. Not a failure and not something to overwrite: a
        binding is what a person's notes are behind, and replacing one because
        a webhook arrived twice is the one mistake in this file that loses
        data. Recorded as ready, because from the customer's side it is.
      */
      await ctx.runMutation(
        internal.functions.managedProvisioning.recordManagedProvisioning,
        { workspaceId: args.workspaceId, state: "ready" },
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
    const apiToken = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
      name: MANAGED_R2_API_TOKEN_SECRET,
    });
    if (accountId === null || typeof apiToken !== "string" || apiToken.length === 0) {
      return await fail("NOT_CONFIGURED");
    }

    const bucket = managedBucketName(args.workspaceId);

    try {
      const permissionGroupId = await resolvePermissionGroupId({
        apiToken,
        name: R2_BUCKET_WRITE_PERMISSION_GROUP,
      });

      try {
        await createR2Bucket({ apiToken, accountId, bucket, jurisdiction: "default" });
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
      const encryptedSecretAccessKey = await encryptSecret(secretAccessKey, requireKeyset(), {
        workspaceId: args.workspaceId,
      });

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
        stage: error instanceof CloudflareApiError ? error.errorCode : "unknown",
      });
      return await fail(
        error instanceof CloudflareApiError ? "CLOUDFLARE_REFUSED" : "PROVISION_FAILED",
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
      hasBinding: v.boolean(),
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
    const owner = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    return {
      // Both halves: chosen *and* paying. `activeEntitlements` is the one place
      // that computes it, and this asks the same question the same way.
      entitled: plan?.managedStorage === true && plan.status === "active",
      hasBinding: binding !== null,
      ownerId: owner.find((member) => member.role === "owner")?.userId ?? null,
    };
  },
});

/** Where an attempt got to. Written by the action, read by the console. */
export const recordManagedProvisioning = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    state: v.union(v.literal("running"), v.literal("ready"), v.literal("failed")),
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

/**
 * Bind the bucket and mark the plan ready, in one transaction.
 *
 * Through `applyBinding` rather than an insert here, for the reason
 * `completeProvisioning` gives on the BYO path: the field resets, the audit
 * event and the scheduled verification are all that function's, and a second
 * copy of them would drift. A managed binding is written by exactly the code
 * that writes a pasted one.
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
  ctx: { db: unknown; scheduler: { runAfter: (ms: number, fn: unknown, args: unknown) => Promise<unknown> } },
  workspaceId: Id<"workspaces">,
): Promise<void> {
  await ctx.scheduler.runAfter(
    0,
    internal.functions.managedProvisioning.provisionManagedStorage,
    { workspaceId },
  );
}
