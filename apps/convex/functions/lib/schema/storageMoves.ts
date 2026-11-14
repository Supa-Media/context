import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The staff console's one-workspace storage move, as it stands (`functions/adminStorage.ts`). One row per workspace,
 * replaced by each new request: the row is what the report reads for "last move", what refuses a second move while one
 * runs, and what a stopped move resumes from.
 *
 * `heartbeatAt` moves on every page of the copy; a `running` row whose heartbeat is older than two minutes is stale
 * (the run was killed) and a new request may resume it from `cursor`. `startedAt` is the run's fence: a run whose
 * `startedAt` is no longer the row's stops without writing.
 *
 * Counts and states only: never a key, a path or a body.
 */
export const storageMoveTables = {
  storageMoves: defineTable({
    workspaceId: v.id("workspaces"),
    to: v.union(v.literal("dual"), v.literal("object")),
    state: v.union(
      v.literal("running"),
      v.literal("done"),
      v.literal("incomplete"),
      v.literal("refused"),
      v.literal("failed"),
    ),
    /** A refusal's reason as the switch gave it (`NOT_BACKFILLED`, ...), or a fixed failure word. */
    reason: v.optional(v.string()),
    startedAt: v.number(),
    heartbeatAt: v.number(),
    /** The backfill copy's cursor after the last page, so a stopped copy resumes there. */
    cursor: v.optional(v.string()),
    /** Whether any page so far held back or failed a body, a row or a rule. */
    gaps: v.optional(v.boolean()),
  }).index("by_workspace", ["workspaceId"]),
};
