import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * How far each workspace's check before it builds its paths from parents has got (`functions/treeFlips.ts`;
 * `paths-on-read.md`, "The flip"). One row per workspace. Counts and times only; `after` is the last stored
 * path a page reached, read only by the check.
 */
export const treeFlipsTables = {
  treeFlips: defineTable({
    workspaceId: v.id("workspaces"),
    /** The last stored path the current walk reached; absent at the start of a walk. */
    after: v.optional(v.string()),
    /** Walks finished so far. */
    walks: v.number(),
    /**
     * In the last finished walk: live rows whose path built from parents is not the path they store, or at
     * which the tree finds another row; and gone rows whose built path differs, counted only (nothing waits on
     * a gone row's name).
     */
    mismatches: v.number(),
    goneMismatches: v.number(),
    rows: v.number(),
    /** The current walk's counts of the same. */
    walkMismatches: v.number(),
    walkGoneMismatches: v.number(),
    walkRows: v.number(),
    /** A walk that found no mismatch ended with a row move in flight, so it did not flip. */
    heldByMove: v.optional(v.boolean()),
    /** When the workspace's switch was set to built paths by this check. */
    flippedAt: v.optional(v.number()),
    /** When the check last ran a page; a page this recent holds the workspace. */
    leaseAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),
};
