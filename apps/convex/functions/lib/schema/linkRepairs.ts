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
    /** Passes that took this entry; past `REPAIR_ATTEMPTS` it is dropped and forwarding sends old links on. */
    attempts: v.number(),
    /** A pass that took this entry this recently holds the workspace's queue. */
    leaseAt: v.optional(v.number()),
    /** A fixed label for the last failed pass. */
    error: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),
};
