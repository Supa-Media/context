import { defineTable } from "convex/server";
import { v } from "convex/values";
import { texStyleValidator } from "../texStyle";

/**
 * How a person's own Tex talks to them (`lib/texStyle.ts`, Dev2, 2026-10-28),
 * one row per person, set from the app or by texting "Tex, settings". Only
 * settings changed from their default are kept; a missing row is every
 * default. Deleted with the account (`personalRows.ts`).
 */
export const texStyleTables = {
  texStylePreferences: defineTable({
    userId: v.id("users"),
    texStyle: texStyleValidator,
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
};
