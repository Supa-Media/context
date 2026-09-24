import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Who may post into a personal context by email, and vault imports.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts` in declaration order. Metadata only — see that
 * file's header.
 */
export const ingestionTables = {
  /**
   * Who may post into a **personal** context by email, and where it lands.
   *
   * ## Why this is a security table, not a preferences table
   *
   * A capture address is `<slug>@context.lc` (see `functions/lib/ingestion.ts`
   * and CLAUDE.md, "Ingestion is on the apex"). It is **semi-public**: the
   * console shows it, people paste it into forwarding rules, and it is
   * guessable from a slug that is itself public addressing. Anything that
   * lands there becomes a note, and notes are read back by the owner's AI
   * clients *as trusted context*. So an open inbox is not a spam problem, it
   * is a durable prompt-injection channel into somebody's own notes.
   *
   * Hence the shape: an allowlist that starts closed, and one explicit boolean
   * to open it. There is no "allow" wildcard string, no regex field, and no
   * suffix rule — every one of those is a way to write a policy that admits
   * more than its author meant.
   *
   * ## Only a personal context has one of these
   *
   * A shared context has no capture address, so it has no row here — not a row
   * with an empty list, no row. Mail lands in a personal context and nowhere
   * else, and a shared context receives a note only when a person moves one
   * there. `functions/lib/ingestionStore.ts` carries the reasoning and
   * `resolvePersonalContextForIngestion` is the single place that decides it.
   *
   * The row is still keyed by `workspaceId` rather than `userId`, because the
   * bucket the capture is written to is keyed that way (`storageBindings`) and
   * a second key would be a second thing to keep in step. The constraint lives
   * on the writers: `seedIngestionSettings` throws for a shared context, and
   * `createWorkspace` only calls it for a personal one.
   *
   * ## One row per personal context, seeded at creation
   *
   * `createWorkspace` writes this row with the owner's account email in
   * `allowedSenders`. Seeded rather than inferred on read: "empty list, accepts
   * nothing" and "the owner's address" are different behaviours the moment mail
   * arrives, and which one a context has should be a stored fact rather than
   * something a later code path derives. A personal context with **no row** is
   * the fail-closed floor — it accepts nothing — and only contexts created
   * before this table existed can be in that state.
   *
   * The seeded entry does not follow a later account-email change. That is
   * deliberate: changing the address you log in with must not silently repoint
   * who can write to your context.
   *
   * Note what is absent: no `enabled` flag. `allowedSenders: []` with
   * `allowedDomains: []` and `allowAnySender: false` already means "accept
   * nothing", and a second way to express off is a second thing to check.
   */
  ingestionSettings: defineTable({
    workspaceId: v.id("workspaces"),
    /**
     * Canonical folder form: no leading slash, exactly one trailing slash
     * (`0-inbox/`). Validated syntactically only — see `normalizeTargetFolder`
     * for why existence is not checked here.
     */
    targetFolder: v.string(),
    /** Normalized addr-specs, lowercased. Capped at `MAX_ALLOWED_SENDERS`. */
    allowedSenders: v.array(v.string()),
    /**
     * Whole domains, lowercased, matched by **exact equality**. A subdomain is
     * a different domain and must be listed separately.
     */
    allowedDomains: v.array(v.string()),
    /** Explicit opt-in to accept from anyone. Never a default. */
    allowAnySender: v.boolean(),
    /**
     * What happens to an attachment: `ignore`, `list`, or `store`. Optional so
     * rows written before this field existed need no backfill; every reader
     * resolves an absent value to `DEFAULT_ATTACHMENT_POLICY`, which is `list`
     * — precisely what the pipeline did while this was a hardcoded constant.
     * An existing context therefore behaves identically on the day this ships.
     */
    attachmentPolicy: v.optional(v.string()),
    /**
     * Per-attachment ceiling in bytes. Absent means
     * `DEFAULT_MAX_ATTACHMENT_BYTES`. Capped on write at
     * `MAX_ATTACHMENT_BYTES_CEILING`, which is bounded by what the gateway will
     * serve back rather than by what a bucket will hold.
     */
    maxAttachmentBytes: v.optional(v.number()),
    updatedBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * Progress for a vault import whose bytes stay on the person's device.
   *
   * This table never stores file bytes or note bodies. A completed batch
   * number is enough for the same locally selected vault to resume without
   * sending finished batches again.
   */
  vaultImportJobs: defineTable({
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    strategy: v.union(v.literal("merge"), v.literal("folder"), v.literal("replace")),
    sourceFingerprint: v.string(),
    totalFiles: v.number(),
    totalBytes: v.number(),
    totalBatches: v.number(),
    completedBatches: v.array(v.number()),
    completedFiles: v.number(),
    createdFiles: v.number(),
    skippedFiles: v.number(),
    /** Present only for destructive imports created after replacement shipped. */
    replacement: v.optional(v.object({
      phase: v.union(v.literal("counting"), v.literal("deleting"), v.literal("uploading")),
      totalObjects: v.number(),
      deletedObjects: v.number(),
    })),
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("complete")),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_workspace_createdAt", ["workspaceId", "createdAt"])
    .index("by_actor_updatedAt", ["actorUserId", "updatedAt"]),
};
