import { defineTable } from "convex/server";
import { v } from "convex/values";
import { texStyleValidator } from "../texStyle";

/**
 * The iMessage group chats Tex has been tagged in (`functions/textGroups.ts`).
 *
 * Metadata only, never a message: which workspace the chat is bound to, who
 * muted it, and whether its intro went. A chat is named by a hash of its line
 * and Sendblue's `group_id`, so this table never holds the id itself, and the
 * participants are never stored here: they arrive with every message and are
 * resolved again each time (decided by the owner, 2026-10-20;
 * `docs/decisions/texting-assistant/groups.md`). A guest chat's numbers are kept
 * beside it as keyed hashes only (`chatGuestPhones`, `lib/guestPhones.ts`).
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
    /** How Tex talks in this chat (`lib/texStyle.ts`, Dev2, 2026-10-28): only changed settings; who changed them last, as `engagementSetBy`. */
    texStyle: v.optional(texStyleValidator),
    texStyleSetBy: v.optional(v.string()),
    texStyleSetAt: v.optional(v.number()),
    lastSeenAt: v.number(),
    /**
     * The chat's own check-in (`lib/textGroupLooks.ts`, decided by the owner, 2026-10-27): when the next look is
     * due (a daily slot, or sooner for new mail shared here), when the last was handed out, and the lease of the one
     * out now. Times only, never what it saw.
     */
    nextLookAt: v.optional(v.number()),
    lastLookAt: v.optional(v.number()),
    lookRunId: v.optional(v.string()),
    lookClaimedAt: v.optional(v.number()),
  })
    .index("by_key", ["groupKey"])
    .index("by_workspace", ["workspaceId"])
    .index("by_nextLookAt", ["nextLookAt"])
    .index("by_look_run", ["lookRunId"]),
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
     * Retired the day they were added (2026-10-27): the chat's look moved to its own row (`textGroups.nextLookAt`).
     * Left so rows written that day still match; nothing reads or writes them.
     */
    nextLookAt: v.optional(v.number()),
    lastLookAt: v.optional(v.number()),
    lookRunId: v.optional(v.string()),
    lookClaimedAt: v.optional(v.number()),
  })
    .index("by_group", ["groupKey"])
    .index("by_user", ["userId"]),
};
