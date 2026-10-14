import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Light, Dark or follow the device, one row per person, so the choice made on
 * a phone holds in the browser and the desktop app too (Dev2, 2026-10-14: "it
 * can't be based off system settings any longer").
 *
 * One word and a time, never anything else. A missing row means the person
 * has not chosen, which every client reads as "follow the device". Deleted
 * with the account (`personalRows.ts`).
 */
export const appearanceTables = {
  appearancePreferences: defineTable({
    userId: v.id("users"),
    appearance: v.union(v.literal("system"), v.literal("light"), v.literal("dark")),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
};
