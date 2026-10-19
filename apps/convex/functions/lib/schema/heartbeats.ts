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
 * person. Deleted with the account (`deleteTextLinksOf`). The same row
 * carries when the person's attention pings are due
 * (`docs/decisions/texting-assistant/attention.md`), which ride the
 * check-in's claim, grant and path to their phone.
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
    /** When a check-in last reached their phone. */
    lastTextedAt: v.optional(v.number()),
    /** The local day (`YYYY-MM-DD`) `textedCount` is for: check-in texts that reached them that day. */
    textedDay: v.optional(v.string()),
    textedCount: v.optional(v.number()),
    /** A code from `HEARTBEAT_OUTCOMES`. Never text. */
    lastOutcome: v.optional(v.string()),
    /** The lease: when a check-in was handed out, and the id its result names. */
    claimedAt: v.optional(v.number()),
    runId: v.optional(v.string()),
    /** What the claim `runId` names is for: a check-in (absent) or the person's waiting attention pings. */
    runKind: v.optional(v.literal("attention")),
    /**
     * Attention pings (`lib/attention/`): when the waiting ones are next due,
     * null or absent when none waits. The pings themselves are in
     * `tex/attention/` in their bucket; only when, and how many, is here.
     */
    attentionDueAt: v.optional(v.union(v.number(), v.null())),
    /** The local day (`YYYY-MM-DD`) the two counts are for, and the counts of pings accepted that day. */
    attentionDay: v.optional(v.string()),
    attentionCount: v.optional(v.number()),
    emergencyCount: v.optional(v.number()),
    /** When pings last reached their phone, so ordinary ones are spaced out. */
    attentionTextedAt: v.optional(v.number()),
    /** Deliveries in a row that failed; the waiting pings are given up after a few. */
    attentionTries: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_workspace", ["workspaceId"])
    .index("by_nextBeatAt", ["nextBeatAt"])
    .index("by_attentionDueAt", ["attentionDueAt"])
    .index("by_run_id", ["runId"]),
};
