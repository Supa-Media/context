import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * How the live map is drawn: its paper, pencil, names, motion and the rest of
 * its look. One row per person, so the choice follows them across phone,
 * browser and desktop, the same way the appearance choice does.
 *
 * Every field is optional and a named, closed choice or a bounded number, so
 * the row can hold only the look and never anything about the notes it draws.
 * A missing row means defaults, and a field left out means its default too.
 * Deleted with the account (`personalRows.ts`).
 */
export const mapLookValidator = v.object({
  board: v.optional(
    v.union(
      v.literal("auto"),
      v.literal("paper"),
      v.literal("graph"),
      v.literal("kraft"),
      v.literal("chalk"),
      v.literal("blueprint"),
    ),
  ),
  sketch: v.optional(v.number()),
  colorBy: v.optional(
    v.union(
      v.literal("topic"),
      v.literal("folder"),
      v.literal("workspace"),
      v.literal("pressure"),
      v.literal("none"),
    ),
  ),
  names: v.optional(v.union(v.literal("busy"), v.literal("all"), v.literal("hover"))),
  textSize: v.optional(v.number()),
  lines: v.optional(v.union(v.literal("all"), v.literal("near"), v.literal("hover"))),
  mergeLines: v.optional(v.boolean()),
  lineWidth: v.optional(v.number()),
  dotSize: v.optional(v.number()),
  spread: v.optional(v.number()),
  reading: v.optional(v.union(v.literal("circle"), v.literal("pulse"), v.literal("halo"))),
  opening: v.optional(
    v.union(v.literal("sketch"), v.literal("bloom"), v.literal("order"), v.literal("zoom")),
  ),
  motion: v.optional(v.union(v.literal("breathe"), v.literal("still"))),
  depth: v.optional(v.boolean()),
  showArchive: v.optional(v.boolean()),
  showOrphans: v.optional(v.boolean()),
  showAgents: v.optional(v.boolean()),
});

export const mapLookTables = {
  mapLookPreferences: defineTable({
    userId: v.id("users"),
    look: mapLookValidator,
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
};
