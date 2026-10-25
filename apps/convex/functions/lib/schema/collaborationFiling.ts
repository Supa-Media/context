import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * How far each workspace's backfill has got in filing its editing history by
 * note id (`functions/collaborationFiling.ts`; `notes-by-id.md`, "Editing
 * history is filed by note id"). One row per workspace. A bucket listing
 * position, counts and fixed labels only, never a path or note text.
 */
export const collaborationFilingTables = {
  collaborationFiling: defineTable({
    workspaceId: v.id("workspaces"),
    /** The listing position the next page starts after; absent before the first page. Read only by the backfill. */
    cursor: v.optional(v.string()),
    done: v.boolean(),
    /** Heads filed by note id so far, and heads whose name had no note to file them under. */
    filed: v.number(),
    left: v.number(),
    /** A pass that ran this recently holds the backfill; another waits. */
    leaseAt: v.optional(v.number()),
    /** A fixed label for the last failed pass, cleared by the next good one. */
    error: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),
};
