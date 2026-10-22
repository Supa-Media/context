import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Trash erasures the control plane has made and the bucket has not finished
 * (`functions/trash.ts`, `notes-by-id.md`, "Emptying the trash").
 *
 * Emptying a trash removes its rows first, in one transaction, so nothing can
 * restore a note whose bytes are going. What is left to remove from the bucket
 * is written here in that same transaction: each note's id key and the trash
 * names whose editing history goes with it. The row is deleted once the
 * bucket has done so; until then the next pass tries again, so a failed
 * delete never leaves bytes behind that nothing remembers.
 *
 * Keys and names only, never note text.
 */
export const trashTables = {
  trashErasures: defineTable({
    workspaceId: v.id("workspaces"),
    /** `.context/trash/<stamp>`: the trash this erases, or `.context/old-copies` for an owner's Delete (`oldCopies.ts`). */
    folder: v.string(),
    /** The note or folder that was trashed, as the audit names it. */
    path: v.string(),
    /** The notes' own keys (`notes/<id>.md`, `files/<id>.<ext>`). */
    keys: v.array(v.string()),
    /** Trash names of Markdown notes, whose collaboration history is erased with them. */
    histories: v.array(v.string()),
    claimedAt: v.number(),
    attempts: v.number(),
    /** A fixed, path-free label for the last failed attempt. */
    error: v.optional(v.string()),
  }).index("by_workspace", ["workspaceId"]),
};
