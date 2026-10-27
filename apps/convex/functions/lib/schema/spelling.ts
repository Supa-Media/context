import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Spelling in the note editor, one row per person (Dev2, 2026-10-27): whether
 * the red underlines are on, which dictionary, and the words the person taught
 * it — so a word added on the phone is not red on the Mac.
 *
 * Settings, not content: the words are ones somebody chose to add, never text
 * read out of a note, and the list is bounded (`functions/spelling.ts`). A
 * missing row means the person has not chosen, which every client reads as
 * "on, in the device's English, no words". Deleted with the account
 * (`personalRows.ts`).
 */
export const spellingTables = {
  spellingPreferences: defineTable({
    userId: v.id("users"),
    enabled: v.boolean(),
    language: v.union(v.literal("en-US"), v.literal("en-GB")),
    words: v.array(v.string()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
};
