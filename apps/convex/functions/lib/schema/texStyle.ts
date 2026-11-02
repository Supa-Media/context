import { defineTable } from "convex/server";
import { v } from "convex/values";
import { texStyleValidator } from "../texStyle";
import { texUpdatesValidator } from "../texInstructions";

/**
 * How a person's own Tex talks to them (`lib/texInstructions.ts`, Dev2,
 * 2026-11-01), one row per person, set from the app or by texting: their
 * instructions, the text before the last change (for "Tex, undo"), and the
 * progress updates switch. A missing row is none and normal. Deleted with the
 * account (`personalRows.ts`).
 */
export const texStyleTables = {
  texStylePreferences: defineTable({
    userId: v.id("users"),
    instructions: v.optional(v.string()),
    instructionsBefore: v.optional(v.string()),
    updates: v.optional(texUpdatesValidator),
    /** The dials before instructions (`lib/texStyle.ts`), unread since 2026-11-01. TODO: drop after the migration. */
    texStyle: v.optional(texStyleValidator),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
};
