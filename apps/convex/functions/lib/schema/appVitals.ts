import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The app's own timings and session outcomes for the Context usage source (`functions/appVitals.ts`): Start time,
 * Load time and Clean sessions (decided by the owner, 2026-11-25: "the app reports them itself").
 *
 * One row per app session per kind. `session` is a random id the app makes at launch and never keeps, so a row names
 * no account, no device and no screen: a platform, a kind, a number of milliseconds and a time.
 */
export const appVitalsTables = {
  appVitals: defineTable({
    at: v.number(),
    platform: v.union(v.literal("web"), v.literal("desktop"), v.literal("ios"), v.literal("android")),
    kind: v.union(v.literal("start"), v.literal("load"), v.literal("session"), v.literal("error")),
    ms: v.optional(v.number()),
    session: v.string(),
  })
    .index("by_session_kind", ["session", "kind"])
    .index("by_at", ["at"]),
};
