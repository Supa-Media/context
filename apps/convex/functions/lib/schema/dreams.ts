import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Tex's nightly dream: when each person's next one is due
 * (`docs/decisions/texting-assistant/dreams.md`).
 *
 * A dream is a turn Tex takes on its own once a night, in the person's
 * personal workspace, to bring `tex/about.md` up to date from the day's
 * texts. What it read, thought and changed is written to `tex/dreams/` in
 * their bucket; nothing it said or changed is kept here.
 *
 * METADATA ONLY: who, which workspace, a few times and a lease, and the last
 * outcome as a code from a closed list (`DREAM_OUTCOMES`). One row per
 * person. Deleted with the account (`deleteTextLinksOf`).
 */
export const dreamTables = {
  texDreams: defineTable({
    userId: v.id("users"),
    /** Their personal workspace when the row was armed; asked again at every claim. */
    workspaceId: v.id("workspaces"),
    /** The last text Tex answered for them, so a quiet night is not dreamed. */
    lastTextedAt: v.optional(v.number()),
    /** Null when nothing new has happened since the last dream. */
    nextDreamAt: v.union(v.number(), v.null()),
    /** The last dream that finished, so the next one reads only what came after. */
    lastDreamedAt: v.optional(v.number()),
    /** A code from `DREAM_OUTCOMES`. Never text. */
    lastOutcome: v.optional(v.string()),
    /** When the person's own agent last asked for a dream now (`lib/dreams/now.ts`), for its window. */
    askedAt: v.optional(v.number()),
    /** When the sweep for people with no about-me made a first look due (`lib/dreams/firstLook.ts`): once each. */
    firstLookAt: v.optional(v.number()),
    /** The lease: when a dream was handed out, and the id its result names. */
    claimedAt: v.optional(v.number()),
    runId: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_nextDreamAt", ["nextDreamAt"])
    .index("by_run_id", ["runId"]),
};
