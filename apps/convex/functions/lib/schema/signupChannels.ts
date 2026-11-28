import { defineTable } from "convex/server";
import { v } from "convex/values";
import { SIGNUP_CHANNELS } from "@context/shared";

/**
 * The one channel each account signed up through (Dev2, 2026-11-28): `ai`,
 * `search`, `social`, `invite`, `direct`, `other`, `tex` or `agent`, worked out
 * once by `signupChannelOf` (`@context/shared`) when the account was made, or
 * within the hour after from the first touch its browser sent
 * (`signupChannels.ts`). One row per account, rewritten only once, from
 * `direct` to the person's own answer when no referrer was seen. Only the
 * channel: the touch it was read from is not kept here. An account made before
 * this shipped has none, and its row in `@supa` `data/usage/sign-ups.csv`
 * stays `unknown`. Deleted with the account.
 */
export const signupChannelTables = {
  signupChannels: defineTable({
    userId: v.id("users"),
    channel: v.union(...SIGNUP_CHANNELS.map((channel) => v.literal(channel))),
    at: v.number(),
    /**
     * Set when the channel is the person's own answer to "How did you hear
     * about us?" (`signupChannels.heard`), asked only when no site or link was
     * seen. Answered once.
     */
    heard: v.optional(v.boolean()),
  })
    .index("by_user", ["userId"])
    .index("by_at", ["at"]),
};
