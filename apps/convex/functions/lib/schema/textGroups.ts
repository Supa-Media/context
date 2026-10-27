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
    /**
     * The accounts in the chat who aren't members of the workspace, named on the chat's folder row to edit so they
     * reach it in the app, and taken off it when they leave the chat (`lib/textGroupGuestSync.ts`). Account ids only,
     * never a phone number.
     */
    guestFolderUsers: v.optional(v.array(v.id("users"))),
    /**
     * How much Tex joins in (Dev2, 2026-10-26; `docs/design/tex-event-log/CONTRACT.md` section 4). Absent: never
     * chosen, so the Worker asks before its first answer and uses `followAlong` meanwhile.
     */
    engagement: v.optional(v.union(v.literal("quiet"), v.literal("attentive"), v.literal("followAlong"), v.literal("helpful"))),
    /** Who chose it: their display handle or label as the Worker named them, or a `groupKey`-salted hash of a number. */
    engagementSetBy: v.optional(v.string()),
    engagementSetAt: v.optional(v.number()),
    lastSeenAt: v.number(),
  })
    .index("by_key", ["groupKey"])
    .index("by_workspace", ["workspaceId"]),
  /**
   * A mailbox its owner shares with one chat (`lib/textGroupMail.ts`, decided by
   * the owner, 2026-10-27; `docs/decisions/texting-assistant/chat-mail.md`):
   * the chat's turns may search and open that Gmail, narrowed by `query`, while
   * the chat is bound to `workspaceId` and the sharer still writes there. The
   * address is the sharer's own; no message is ever kept here.
   */
  chatMailShares: defineTable({
    groupKey: v.string(),
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    /** Lower-cased: one of the sharer's own connected Gmail addresses. */
    address: v.string(),
    /** A Gmail search every read is narrowed by, or none for the whole mailbox. */
    query: v.optional(v.string()),
    createdAt: v.number(),
    /**
     * The chat's own look at new mail (`lib/textGroupMailLooks.ts`): due when
     * new mail reaches a mailbox shared there, the last one handed out, and
     * the lease of the one out now.
     */
    nextLookAt: v.optional(v.number()),
    lastLookAt: v.optional(v.number()),
    lookRunId: v.optional(v.string()),
    lookClaimedAt: v.optional(v.number()),
  })
    .index("by_group", ["groupKey"])
    .index("by_user", ["userId"])
    .index("by_nextLookAt", ["nextLookAt"])
    .index("by_look_run", ["lookRunId"]),
};
