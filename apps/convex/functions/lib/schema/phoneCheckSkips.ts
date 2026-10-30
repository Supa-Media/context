import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * People who tapped "Skip for now" on the phone step after an email sign-in
 * (Dev2, 2026-10-29: "Ask, but let them skip"). One row per person, kept on the
 * account so the step is never asked again on another device. A missing row
 * means they have not skipped. Adding a phone later in Settings › Account works
 * as before. Deleted with the account (`personalRows.ts`).
 */
export const phoneCheckSkipTables = {
  phoneCheckSkips: defineTable({
    userId: v.id("users"),
    skippedAt: v.number(),
  }).index("by_user", ["userId"]),
};
