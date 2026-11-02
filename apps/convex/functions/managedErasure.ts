import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import {
  CloudflareApiError,
  deleteEmptyR2Bucket,
  eraseR2ObjectsPage,
  revokeBucketToken,
} from "./lib/cloudflare";
import { MANAGED_R2_API_TOKEN_SECRET, managedAccountId, managedBucketName } from "./lib/managedStorage";

/**
 * Erasing a deleted workspace's managed bucket, retried until it is done.
 *
 * The queue row is written by the workspace cascade (`lib/managedErasure/
 * queue.ts`) in the transaction that deletes the binding; everything here
 * runs after, with nobody present. One run claims the row, revokes the
 * bucket's scoped token, deletes a bounded number of pages of objects, deletes
 * the bucket once it is empty, and records what it did. A run that hit a
 * provider failure is retried with backoff; a run that died without recording
 * anything is picked up by the cron once its lease lapses. Nothing ever gives
 * up: a row stays pending, and visible, until the bucket is gone.
 *
 * Token first, then objects. The binding row holding the token's secret half
 * is already deleted, so revoking it takes nothing from anybody, and it closes
 * the one way new objects could arrive while the bucket is being emptied.
 * The two steps are independent: a token step that fails does not hold up
 * the erasure of the notes, and the reverse.
 *
 * See `docs/decisions/storage-and-credentials/managed-erasure.md`.
 */

/** How long a run may hold a row before another may take it. Above an action's limit. */
export const ERASURE_LEASE_MS = 15 * 60 * 1000;

/** Pages per run, and wall time per run: a large bucket is many runs, each recorded. */
const PAGES_PER_RUN = 5;
const RUN_BUDGET_MS = 4 * 60 * 1000;

/** Backoff after a failed run: one minute, doubling, at most six hours. */
export function erasureBackoffMs(failures: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, failures - 1), 6 * 60 * 60 * 1000);
}

function errorCode(error: unknown): string {
  if (error instanceof CloudflareApiError) return error.errorCode;
  return "ERASE_FAILED";
}

const tokenOutcome = v.union(v.literal("revoked"), v.literal("absent"), v.literal("not_for_bucket"));

/** Take a pending row for one run. Null when it is done, refused, held, or not yet due. */
export const claimManagedErasure = internalMutation({
  args: { erasureId: v.id("managedErasures") },
  returns: v.union(
    v.null(),
    v.object({
      workspaceId: v.id("workspaces"),
      bucket: v.string(),
      tokenId: v.optional(v.string()),
      tokenPending: v.boolean(),
      bucketDeleted: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.erasureId);
    const now = Date.now();
    if (row === null || row.status !== "pending") return null;
    if (row.leaseUntil !== undefined && row.leaseUntil > now) return null;
    if (row.nextAttemptAt > now) return null;
    await ctx.db.patch(row._id, { leaseUntil: now + ERASURE_LEASE_MS, updatedAt: now });
    return {
      workspaceId: row.workspaceId,
      bucket: row.bucket,
      tokenId: row.tokenId,
      tokenPending: row.token === "pending",
      bucketDeleted: row.bucketDeleted,
    };
  },
});

/**
 * Record one run and decide the next: done, again at once (more pages), or
 * again after backoff (a failure). Releases the lease either way.
 */
export const recordManagedErasureRun = internalMutation({
  args: {
    erasureId: v.id("managedErasures"),
    token: v.optional(tokenOutcome),
    bucketDeleted: v.boolean(),
    objectsDeleted: v.number(),
    error: v.optional(v.string()),
    refused: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.erasureId);
    if (row === null || row.status !== "pending") return null;
    const now = Date.now();
    if (args.refused === true) {
      await ctx.db.patch(row._id, {
        status: "refused",
        lastError: args.error ?? "FOREIGN_BUCKET",
        leaseUntil: undefined,
        updatedAt: now,
        completedAt: now,
      });
      return null;
    }
    const token = args.token ?? row.token;
    const bucketDeleted = row.bucketDeleted || args.bucketDeleted;
    const objectsDeleted = row.objectsDeleted + args.objectsDeleted;
    if (bucketDeleted && token !== "pending") {
      await ctx.db.patch(row._id, {
        status: "done",
        token,
        bucketDeleted,
        objectsDeleted,
        leaseUntil: undefined,
        lastError: token === "not_for_bucket" ? "TOKEN_NOT_FOR_BUCKET" : undefined,
        updatedAt: now,
        completedAt: now,
      });
      return null;
    }
    const attempts = args.error === undefined ? row.attempts : row.attempts + 1;
    const delay = args.error === undefined ? 0 : erasureBackoffMs(attempts);
    await ctx.db.patch(row._id, {
      token,
      bucketDeleted,
      objectsDeleted,
      attempts,
      lastError: args.error,
      leaseUntil: undefined,
      nextAttemptAt: now + delay,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(delay, internal.functions.managedErasure.runManagedErasure, {
      erasureId: row._id,
    });
    return null;
  },
});

/** One bounded run. Every outcome, a thrown one included, ends in a record. */
export const runManagedErasure = internalAction({
  args: { erasureId: v.id("managedErasures") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claim = await ctx.runMutation(internal.functions.managedErasure.claimManagedErasure, args);
    if (claim === null) return null;
    const record = (outcome: {
      token?: "revoked" | "absent" | "not_for_bucket";
      bucketDeleted?: boolean;
      objectsDeleted?: number;
      error?: string;
      refused?: boolean;
    }) =>
      ctx.runMutation(internal.functions.managedErasure.recordManagedErasureRun, {
        erasureId: args.erasureId,
        token: outcome.token,
        bucketDeleted: outcome.bucketDeleted ?? false,
        objectsDeleted: outcome.objectsDeleted ?? 0,
        error: outcome.error,
        refused: outcome.refused,
      });

    // The row is data. Re-derive the one bucket this workspace could own.
    let expected: string;
    try {
      expected = managedBucketName(claim.workspaceId as Id<"workspaces">);
    } catch {
      expected = "";
    }
    if (claim.bucket !== expected) {
      console.error("managed_erasure.refused", { erasureId: args.erasureId, workspaceId: claim.workspaceId });
      await record({ refused: true, error: "FOREIGN_BUCKET" });
      return null;
    }

    let accountId: string | null = null;
    try {
      accountId = managedAccountId();
    } catch {
      accountId = null;
    }
    const apiToken = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
      name: MANAGED_R2_API_TOKEN_SECRET,
    });
    if (accountId === null || typeof apiToken !== "string" || apiToken.length === 0) {
      console.error("managed_erasure.not_configured", { erasureId: args.erasureId });
      await record({ error: "NOT_CONFIGURED" });
      return null;
    }

    let token: "revoked" | "absent" | "not_for_bucket" | undefined;
    let error: string | undefined;
    if (claim.tokenPending && claim.tokenId !== undefined) {
      try {
        token = await revokeBucketToken({ apiToken, accountId, bucket: claim.bucket, tokenId: claim.tokenId });
      } catch (failure) {
        error = errorCode(failure);
      }
    }

    let bucketDeleted = claim.bucketDeleted;
    let objectsDeleted = 0;
    if (!bucketDeleted) {
      const started = Date.now();
      try {
        for (let page = 0; page < PAGES_PER_RUN && Date.now() - started < RUN_BUDGET_MS; page += 1) {
          const result = await eraseR2ObjectsPage({ apiToken, accountId, bucket: claim.bucket });
          objectsDeleted += result.deleted;
          if (result.bucketMissing) {
            bucketDeleted = true;
            break;
          }
          if (!result.more) {
            await deleteEmptyR2Bucket({ apiToken, accountId, bucket: claim.bucket });
            bucketDeleted = true;
            break;
          }
        }
      } catch (failure) {
        error = error ?? errorCode(failure);
      }
    }

    console.log("managed_erasure.run", {
      erasureId: args.erasureId,
      workspaceId: claim.workspaceId,
      objectsDeleted,
      bucketDeleted,
      token: token ?? (claim.tokenPending ? "pending" : "settled"),
      error: error ?? null,
    });
    await record({ token, bucketDeleted, objectsDeleted, error });
    return null;
  },
});

/**
 * The safety net: any pending row that is due and not held gets a run. Covers
 * a run that died before it could record, and a deploy that dropped a
 * scheduled function. The claim is what stops two runs at once.
 */
export const sweepManagedErasures = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("managedErasures")
      .withIndex("by_status_next", (q) => q.eq("status", "pending").lte("nextAttemptAt", now))
      .take(100);
    let scheduled = 0;
    for (const row of due) {
      if (row.leaseUntil !== undefined && row.leaseUntil > now) continue;
      await ctx.scheduler.runAfter(0, internal.functions.managedErasure.runManagedErasure, { erasureId: row._id });
      scheduled += 1;
    }
    return scheduled;
  },
});
