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
    /**
     * Guest mode (`lib/textGroupGuests.ts`, decided by the owner, 2026-10-25): the chat's own group in
     * `workspaceId`, named with three words, and its folder, shared with that group to edit. Set together, by an
     * owner or editor saying "Tex, use @slug"; while set the chat reads only what is shared with the group.
     */
    guestGroupId: v.optional(v.id("workspaceGroups")),
    guestFolder: v.optional(v.string()),
    /** The token the folder is shared behind until it has a row of its own (`lib/nodes/chatFolders.ts`). */
    guestToken: v.optional(v.string()),
    /** The folder's row has been given the group's grant once; from then on the row is the owner's to change. */
    guestFolderGranted: v.optional(v.boolean()),
    lastSeenAt: v.number(),
  })
    .index("by_key", ["groupKey"])
    .index("by_workspace", ["workspaceId"]),
};
