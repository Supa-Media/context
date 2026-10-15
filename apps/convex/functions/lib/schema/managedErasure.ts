import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Erasing the storage we ran for a workspace that no longer exists.
 *
 * When an account is deleted, every workspace it solely owns goes with it
 * (`functions/account.ts`), and where that workspace's notes lived in a bucket
 * we created for it, the notes and attachments go too (decided by the owner,
 * 2026-10-15). The binding row that named the bucket and its token is deleted
 * in the same transaction, so this row is written first and is the one handle
 * left: a job that fails at the provider, times out, or is interrupted by a
 * deploy is retried from here until the bucket and the token are both gone.
 *
 * It holds no credential and no content: a workspace id (of a workspace that
 * has been deleted), the bucket's name derived from it, and the id of the
 * token minted for that bucket. The operator credential that does the erasing
 * stays in `appSecrets` and is opened only by the action.
 *
 * See `docs/decisions/storage-and-credentials/managed-erasure.md`.
 */
export const managedErasureTables = {
  managedErasures: defineTable({
    workspaceId: v.id("workspaces"),
    bucket: v.string(),
    /** The bucket's scoped token, by id; absent when none was ever recorded. */
    tokenId: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("done"), v.literal("refused")),
    bucketDeleted: v.boolean(),
    token: v.union(
      v.literal("pending"),
      v.literal("revoked"),
      v.literal("absent"),
      /** Cloudflare named the id something other than this bucket's token: left standing. */
      v.literal("not_for_bucket"),
    ),
    objectsDeleted: v.number(),
    attempts: v.number(),
    /** When the next run may start. Pending rows are found by this. */
    nextAttemptAt: v.number(),
    /** A run holds the row until then; a run that died is retried after it. */
    leaseUntil: v.optional(v.number()),
    /** Ours, from a closed set; never provider text. */
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_bucket", ["bucket"])
    .index("by_status_next", ["status", "nextAttemptAt"]),
};
