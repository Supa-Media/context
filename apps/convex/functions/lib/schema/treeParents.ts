import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * How far each keyed workspace's check of its tree's parent pointers has got
 * (`functions/treeParents.ts`; `paths-on-read.md`, "Every row's parent and name
 * are its path"). One row per workspace. Counts and times only;
 * `after` is the last path a page reached, read only by the check.
 */
export const treeParentsTables = {
  treeParents: defineTable({
    workspaceId: v.id("workspaces"),
    /** The last path the current walk reached; absent at the start of a walk. */
    after: v.optional(v.string()),
    /** Walks finished so far. */
    walks: v.number(),
    /** Rows the current walk set right: a name, or a parent. A walk that sets nothing right ends the check. */
    walkRepaired: v.number(),
    /** Set right over every walk. */
    repairedNames: v.number(),
    repairedParents: v.number(),
    /**
     * In the last finished walk: live rows whose parent path holds no live folder row, and paths more than one
     * live row holds. Neither is set right here; each is a row a path built from parents could not reach.
     */
    orphans: v.number(),
    /** Of `orphans`, those under a dot folder (`.context/trash/…`). */
    hiddenOrphans: v.optional(v.number()),
    duplicates: v.number(),
    /** The current walk's counts of the same, moved to `orphans`/`duplicates` when it finishes. */
    walkOrphans: v.number(),
    walkHiddenOrphans: v.optional(v.number()),
    walkDuplicates: v.number(),
    /** Live rows the last finished walk read. */
    rows: v.number(),
    walkRows: v.number(),
    /** A walk finished with nothing to set right. */
    done: v.boolean(),
    /** When the check last ran a page; a page this recent holds the workspace. */
    leaseAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),
};
