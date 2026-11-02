/**
 * A group chat's turn, told to each workspace's object first where it may take access away there.
 *
 * Two kinds of turn may. A legacy guest chat's (`lib/textGroupGuests.ts`): the chat's people leave its folder and group
 * when guest mode ends (`clearGuests`, on any turn of a guest chat that now works on its own workspace, and on "Tex, add
 * everyone here to @slug"), and the folder's list follows the people in it (`lib/textGroupGuestSync.ts`). And any chat
 * with a home (`lib/textGroupHome.ts` `makeChatHome`): the home's row names exactly the chat's people, so a turn after
 * somebody left takes them off it, in the pinned workspace (production's report named a home's write, 2026-11-02). A
 * mutation cannot ask the object, so the gateway route asks here which workspaces a turn may touch and runs the turn
 * inside `objectFirst` (`lib/rowWatch/objectFirst.ts`) for each. A chat with neither runs as it is, with no wait added.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { sealedPin } from "./lib/textGroupHome";

/** The workspaces a chat's turn may narrow a row in: a legacy guest chat's own, then the pinned one for a home. */
export const turnWorkspaces = internalQuery({
  args: { groupKey: v.string() },
  returns: v.array(v.id("workspaces")),
  handler: async (ctx, { groupKey }) => {
    const chat = await ctx.db
      .query("textGroups")
      .withIndex("by_key", (q) => q.eq("groupKey", groupKey))
      .unique();
    if (chat === null) return [];
    const marked = [];
    const guest = chat.guestGroupId !== undefined || chat.guestFolder !== undefined || chat.guestToken !== undefined;
    if (guest && chat.workspaceId !== undefined) marked.push(chat.workspaceId);
    // A chat with no home yet makes one under a fresh name: rows born in the turn narrow nothing (`rowWatch/watch.ts`).
    const pinned = chat.homeWords === undefined ? null : await sealedPin(ctx);
    if (pinned !== null && !marked.includes(pinned)) marked.push(pinned);
    return marked;
  },
});
