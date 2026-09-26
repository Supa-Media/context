import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Auto-organize: one row per workspace, holding switches and counters only.
 *
 * The suggestions themselves name notes and say things about them, so they
 * live in the customer's bucket (`.context/organizer/state.json`, see
 * `mcp/src/organizer/state.js`), never here. What is here is what a schedule
 * and a settings screen need: whether it is on, when it may first run, how
 * the last sweep went in numbers, and how many suggestions are waiting.
 *
 * Premium includes auto-organize and it is **on unless switched off**
 * (decided by the owner, 2026-09-26; see
 * docs/decisions/storage-and-credentials/inference.md). A missing row on a
 * paying workspace therefore means "on, but this owner has not been told yet":
 * the one-time notice is owed before the first sweep, which is what `startsAt`
 * gates.
 */
export const organizerTables = {
  organizerSettings: defineTable({
    workspaceId: v.id("workspaces"),
    /** Switched off by the owner. Absent or false is on. */
    off: v.optional(v.boolean()),
    /** When the owner was told it is on: at checkout, or the one-time notice. */
    noticeAt: v.optional(v.number()),
    /** The first sweep may not start before this. */
    startsAt: v.optional(v.number()),
    /** "Without asking", per kind of suggestion. */
    autopilot: v.object({
      done: v.boolean(),
      archive: v.boolean(),
      file: v.boolean(),
    }),
    /** The latest sweep, in numbers. Never a path, never a title. */
    sweep: v.optional(
      v.object({
        state: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
        startedAt: v.number(),
        finishedAt: v.union(v.number(), v.null()),
        read: v.number(),
        total: v.number(),
        found: v.object({ done: v.number(), archive: v.number(), file: v.number() }),
      }),
    ),
    /** Suggestions waiting, as last counted. Drives "11 suggestions". */
    pending: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_startsAt", ["startsAt"]),
};
