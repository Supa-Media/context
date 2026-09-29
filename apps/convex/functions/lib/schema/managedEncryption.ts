import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Managed-storage encryption: the staff rollout, and where each managed
 * workspace is in it.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts`. Metadata only: counts, states and error codes.
 * Keys live in `workspaceDataKeys`; object bytes live in the bucket. See
 * `docs/decisions/storage-and-credentials/managed-encryption.md`.
 */

export const managedEncryptionWorkspaceState = v.union(
  /** In the rollout's scope; the walk has not started. Objects are plain. */
  v.literal("waiting"),
  /** Sealing plain objects page by page. Reads accept both. */
  v.literal("encrypting"),
  /** Every object reads back sealed and opens. Reads still accept both. */
  v.literal("checking"),
  /** Checked. Reads refuse a plain body. New saves are sealed. */
  v.literal("encrypted"),
  /** The walk stopped on a problem. Reads accept both; staff retry. */
  v.literal("failed"),
  /**
   * Staff chose Decrypt: the walk back is opening sealed objects in place.
   * Reads accept both; new saves are plain. A failure keeps this state (with
   * an `errorCode`), never `failed`, which would seal new saves again.
   */
  v.literal("decrypting"),
  /** Walked back and checked: every object is plain, and the store is plain. */
  v.literal("decrypted"),
);

export const managedEncryptionTables = {
  /**
   * At most one row: the rollout. Absent means off and never started.
   *
   * `acceptsNew` is whether a workspace joins the rollout when it first gets a
   * managed bucket. "Stop starting new workspaces" clears it and leaves every
   * workspace already encrypting or encrypted exactly as it is: turning the
   * rollout off never makes an encrypted workspace plain.
   */
  managedEncryptionRollout: defineTable({
    state: v.union(
      v.literal("off"),
      v.literal("running"),
      v.literal("paused"),
      v.literal("failed"),
      v.literal("complete"),
    ),
    scope: v.union(v.literal("ours"), v.literal("picked"), v.literal("all")),
    acceptsNew: v.boolean(),
    startedBy: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    changedBy: v.optional(v.string()),
    pauseReason: v.optional(v.string()),
    updatedAt: v.number(),
  }),

  /**
   * One row per managed workspace the rollout has reached. Only read while
   * the workspace's binding is its managed bucket. It outlives a move out:
   * the kept bucket still holds sealed files, and binding it again sends the
   * row back to `encrypting` (`managedBucketBound`), never to plain.
   */
  managedEncryptionWorkspaces: defineTable({
    workspaceId: v.id("workspaces"),
    state: managedEncryptionWorkspaceState,
    /**
     * Within `encrypting`: `count` lists once for the total, `seal` seals.
     * `checking` is its own state. Within `decrypting`: `unseal`, then
     * `confirm`, which re-reads everything. Absent before the walk starts.
     */
    phase: v.optional(
      v.union(v.literal("count"), v.literal("seal"), v.literal("check"), v.literal("unseal"), v.literal("confirm")),
    ),
    /** The walk's listing cursor within its current phase. */
    cursor: v.optional(v.string()),
    filesDone: v.number(),
    filesTotal: v.optional(v.number()),
    /** Stable code only, never a message: `VERIFY_FAILED`, `KEY_UNAVAILABLE`… */
    errorCode: v.optional(v.string()),
    /** Bumped on every run the walk schedules, so a stale run stops itself. */
    runId: v.number(),
    completedAt: v.optional(v.number()),
    /** The staff member who last chose Decrypt for this workspace. */
    changedBy: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_state", ["state"]),
};
