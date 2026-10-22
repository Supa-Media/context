import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Hiding the copies Context made of a person's mail, calendar, chat, contacts
 * and iMessage before it stopped making them (owner, 2026-10-21;
 * `docs/decisions/communications/live-not-copied.md`, `functions/oldCopies.ts`).
 *
 * One row per workspace whose copies were looked for. Its counts are what the
 * Old copies page says, and what Delete the copies removes: counted as each
 * copy is hidden, so the page reads one row rather than every hidden note.
 *
 * Counts, dates and states only, never a path or a note's text.
 */
export const oldCopiesTables = {
  oldCopyHides: defineTable({
    workspaceId: v.id("workspaces"),
    /**
     * `hiding` while the passes walk the workspace (`cursor` is where the next
     * starts); `hidden` once every row was looked at; `deleting` from the
     * owner's Delete until the last hidden row is gone; then `deleted`.
     */
    state: v.union(v.literal("hiding"), v.literal("hidden"), v.literal("deleting"), v.literal("deleted")),
    cursor: v.optional(v.string()),
    /** Day notes hidden: one per channel, account and day. */
    days: v.number(),
    /** Contact pages hidden: those with nothing of the person's under `## Notes`. */
    contacts: v.number(),
    /** Mail attachments hidden. */
    files: v.number(),
    /** The first and last day a hidden day note is of, `YYYY-MM-DD`. */
    firstDay: v.optional(v.string()),
    lastDay: v.optional(v.string()),
    startedAt: v.number(),
    /** When the pass under way began; unset between runs, so `catchUp` starts no second pass beside it. */
    passAt: v.optional(v.number()),
    hiddenAt: v.optional(v.number()),
    /** The owner chose Keep them hidden: the Settings row goes, and the copies stay as they are. */
    keptAt: v.optional(v.number()),
    deleteAskedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
  }).index("by_workspace", ["workspaceId"]),
};
