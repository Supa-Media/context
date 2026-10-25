import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Moves whose links have not followed them yet (`functions/linkRepairs.ts`;
 * `paths-on-read.md`, "Links follow a move in the background"). A row move
 * queues one entry per page of the files it moved; a pass rewrites the links
 * to them and inside them, then deletes the entry. Names of notes, as the
 * `nodes` rows are; never note text.
 */
export const linkRepairTables = {
  linkRepairs: defineTable({
    workspaceId: v.id("workspaces"),
    /** The files one move carried, old name to new, at most `REPAIR_PAIRS` of them. */
    pairs: v.array(v.object({ from: v.string(), to: v.string() })),
    /**
     * A folder moved on built paths (`lib/nodes/builtMove.ts`), whose files are not listed at the move: the
     * moved row, where it was, and the last path beneath it already turned into pairs. Each pass that meets it
     * turns the next page of the files now beneath the row into an entry of `pairs` (`expandFolder`).
     */
    folder: v.optional(v.object({ rootId: v.id("nodes"), from: v.string(), after: v.optional(v.string()) })),
    /** Passes that took this entry; past `REPAIR_ATTEMPTS` it is dropped and forwarding sends old links on. */
    attempts: v.number(),
    /** A pass that took this entry this recently holds the workspace's queue. */
    leaseAt: v.optional(v.number()),
    /** A fixed label for the last failed pass. */
    error: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),
};
