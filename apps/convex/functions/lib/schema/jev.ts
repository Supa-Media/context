import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Jev smarts: the switches and the meter. See `lib/jev/README.md`.
 *
 * Neither table holds a question, an answer or a path. Usage is counts per
 * day, per feature, per workspace; a switch is a feature name and a boolean.
 */
export const jevTables = {
  /** One row per (day, feature, workspace). Numbers only. */
  jevUsage: defineTable({
    /** UTC day, `YYYY-MM-DD`. */
    day: v.string(),
    feature: v.string(),
    workspaceId: v.id("workspaces"),
    /** Requests that reached Jev and came back answered. */
    calls: v.number(),
    /** Requests that reached the Worker and failed there. */
    failed: v.number(),
    /** Requests the framework refused: switched off, or over the daily cap. */
    refused: v.number(),
    questions: v.number(),
    /** Estimated input tokens (Jev bills input only). */
    tokens: v.number(),
    /** Estimated cost in millionths of a US dollar, at `JEV_USD_PER_MTOK`. */
    costMicroUsd: v.number(),
    /** Time spent waiting on Jev, summed. */
    ms: v.number(),
    updatedAt: v.number(),
  })
    .index("by_day_feature_workspace", ["day", "feature", "workspaceId"])
    .index("by_feature_day", ["feature", "day"])
    .index("by_workspace", ["workspaceId"]),

  /**
   * Kill switches. `feature: "*"` is every feature at once. A missing row is
   * the feature's registry default (`lib/jev/features.ts`).
   */
  jevSwitches: defineTable({
    feature: v.string(),
    off: v.boolean(),
    reason: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_feature", ["feature"]),
};
