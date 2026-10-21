import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The iMessage group chats Tex has been tagged in (`functions/textGroups.ts`).
 *
 * Metadata only, never a message: which workspace the chat is bound to, who
 * muted it, and whether its intro went. A chat is named by a hash of its line
 * and Sendblue's `group_id`, so this table never holds the id itself, and the
 * participants are never stored at all: they arrive with every message and are
 * resolved again each time (decided by the owner, 2026-10-20;
 * `docs/decisions/texting-assistant/groups.md`).
 */
export const textGroupTables = {
  textGroups: defineTable({
    /** sha256 of `<line>:<group_id>`. */
    groupKey: v.string(),
    /** The one shared workspace this chat reads, writes and remembers in, once chosen. */
    workspaceId: v.optional(v.id("workspaces")),
    boundBy: v.optional(v.id("users")),
    /** "Tex, stop": nothing but "Tex, start" is answered until it is lifted. */
    mutedAt: v.optional(v.number()),
    mutedBy: v.optional(v.id("users")),
    /** When the one intro line went, so it goes once. */
    introducedAt: v.optional(v.number()),
    /** Hashes of senders who are not set up and were told so once (`groupKey`-salted, never a number). */
    toldUnknown: v.optional(v.array(v.string())),
    lastSeenAt: v.number(),
  }).index("by_key", ["groupKey"]),
};
