import { defineTable } from "convex/server";
import { v } from "convex/values";

export const meaningStatusValidator = v.union(
  /** Creating the index in Cloudflare. */
  v.literal("provisioning"),
  /** The index exists; existing notes are still being read into it. */
  v.literal("backfilling"),
  /** Serving searches. New and changed notes are added as they are saved. */
  v.literal("ready"),
  /** Setting up did not finish; `error` says why. */
  v.literal("failed"),
  /** Turned off, index not deleted yet. Serves nothing. */
  v.literal("releasing"),
);

/**
 * One workspace's meaning index: a Cloudflare Vectorize index of fingerprints
 * of its notes, for search by meaning (decided by the owner, 2026-10-07: build
 * it, on the free plan and Premium). See
 * `docs/decisions/search/meaning-search.md`.
 *
 * Like `searchIndexes`, this points at a **disposable derivative** on our
 * infrastructure, holding no customer credential and no note text: deleting
 * every row here costs a rebuild and loses nothing. A row that loses its
 * `indexName` before the remote index is gone is an index nothing will ever
 * clean up, which is why `releasing` keeps it until the delete is confirmed.
 */
export const meaningTables = {
  meaningIndexes: defineTable({
    workspaceId: v.id("workspaces"),
    /** Whether search by meaning should exist for this workspace. */
    enabled: v.boolean(),
    /** Who turned it on; absent when Context turned it on for everyone. */
    enabledBy: v.optional(v.id("users")),
    enabledAt: v.number(),
    status: meaningStatusValidator,
    /** The Vectorize index's name, once it exists. Configuration, not a secret. */
    indexName: v.optional(v.string()),
    /** Ours, from a closed set — never a provider's text. */
    errorCode: v.optional(v.string()),
    /** Operator-facing detail. Never a credential. */
    error: v.optional(v.string()),
    /** Backfill progress, so the app can say how far it has got. */
    notesIndexed: v.optional(v.number()),
    notesPending: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_status", ["status"])
    // The sweep's: the rows of one status that have waited longest.
    .index("by_status_updated", ["status", "updatedAt"]),
};
