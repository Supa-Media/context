import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Tex's check-in: when each person's next one is due
 * (`docs/decisions/texting-assistant/heartbeat.md`).
 *
 * A check-in is a turn Tex takes on its own a few times a day, in the
 * person's personal workspace, to look at what changed and text them only
 * when something is worth it. What it saw and decided is written to
 * `tex/heartbeat/` in their bucket; nothing it read or said is kept here.
 *
 * METADATA ONLY: who, which workspace, a few times and a lease, and the last
 * outcome as a code from a closed list (`HEARTBEAT_OUTCOMES`). One row per
 * person. Deleted with the account (`deleteTextLinksOf`).
 */
export const heartbeatTables = {
  texHeartbeats: defineTable({
    userId: v.id("users"),
    /** Their personal workspace when the row was armed; asked again at every claim. */
    workspaceId: v.id("workspaces"),
    /** Null while check-ins wait for their next text (no model, or no chat to text into). */
    nextBeatAt: v.union(v.number(), v.null()),
    /** When the last finished check-in started, so the next one looks only at what came after. */
    lastBeatAt: v.optional(v.number()),
    /** When a check-in last reached their phone: at most one a day. */
    lastTextedAt: v.optional(v.number()),
    /** A code from `HEARTBEAT_OUTCOMES`. Never text. */
    lastOutcome: v.optional(v.string()),
    /** The lease: when a check-in was handed out, and the id its result names. */
    claimedAt: v.optional(v.number()),
    runId: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_nextBeatAt", ["nextBeatAt"])
    .index("by_run_id", ["runId"]),
};
