/**
 * A group chat's turn, told to the workspace's object first when it may take access away there.
 *
 * Only a legacy guest chat's turn does (`lib/textGroupGuests.ts`): the chat's people leave its folder and group when
 * guest mode ends (`clearGuests`, on any turn of a guest chat that now works on its own workspace, and on "Tex, add
 * everyone here to @slug"), and the folder's list follows the people in it (`lib/textGroupGuestSync.ts`). A mutation
 * cannot ask the object, so the gateway route asks here which workspace such a chat touches and runs the turn inside
 * `objectFirst` (`lib/rowWatch/objectFirst.ts`). Every other chat's turn writes no tree row or rule and runs as it is,
 * with no wait added to it.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

/** The workspace a legacy guest chat's folder and group live in, or `null` for any other chat. */
export const guestChatWorkspace = internalQuery({
  args: { groupKey: v.string() },
  returns: v.union(v.id("workspaces"), v.null()),
  handler: async (ctx, { groupKey }) => {
    const chat = await ctx.db
      .query("textGroups")
      .withIndex("by_key", (q) => q.eq("groupKey", groupKey))
      .unique();
    if (chat === null || chat.workspaceId === undefined) return null;
    if (chat.guestGroupId === undefined && chat.guestFolder === undefined && chat.guestToken === undefined) return null;
    return chat.workspaceId;
  },
});
