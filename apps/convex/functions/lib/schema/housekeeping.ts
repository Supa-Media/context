import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Tex's housekeeping: when each person's next run is due
 * (`docs/decisions/texting-assistant/housekeeping.md`).
 *
 * Once a day Tex tidies the person's personal workspace: archives finished
 * projects, fixes stale statuses, merges duplicate contacts, folds thin
 * folders. Every change is logged in `tex/housekeeping/` in their bucket;
 * nothing it read or changed is kept here.
 *
 * METADATA ONLY: who, which workspace, a few times and a lease, and the last
 * outcome as a code from a closed list (`HOUSEKEEPING_OUTCOMES`). One row per
 * person. Deleted with the account (`deleteTextLinksOf`).
 */
export const housekeepingTables = {
  texHousekeeping: defineTable({
    userId: v.id("users"),
    /** Their personal workspace when the row was armed; asked again at every claim. */
    workspaceId: v.id("workspaces"),
    /** Null while runs wait for their next text (no model). */
    nextRunAt: v.union(v.number(), v.null()),
    /** When the last finished run started. */
    lastRunAt: v.optional(v.number()),
    /** A code from `HOUSEKEEPING_OUTCOMES`. Never text. */
    lastOutcome: v.optional(v.string()),
    /** The lease: when a run was handed out, and the id its result names. */
    claimedAt: v.optional(v.number()),
    runId: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_nextRunAt", ["nextRunAt"])
    .index("by_run_id", ["runId"]),
};
