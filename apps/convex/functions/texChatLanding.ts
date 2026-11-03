/**
 * Which group chats' Durable Objects a batch of arriving notes would be kept in (decided by the owner, 2026-10-31;
 * `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * A note landing under a chat's home in the pinned workspace is kept in that chat's object, not in the bucket
 * (`lib/noteIds/texHome.ts`). The console's store may reach only the objects its Tex ticket names, so a move into a
 * home asks here, from the destination paths alone, which chats those are. Nothing is taken from the caller: a path
 * that is not under exactly one chat's home names no chat, and a workspace that is not the pinned one names none.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { texHomesFor } from "./lib/noteIds/texHome";

export const chatsOfHomes = internalQuery({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, { workspaceId, paths }) => {
    const homes = await texHomesFor(ctx, workspaceId, paths);
    const keys = new Set<string>();
    for (const owner of homes.values()) if (owner.startsWith("chat:")) keys.add(owner.slice("chat:".length));
    return [...keys];
  },
});

/**
 * Whether `chat`'s home is in `workspaceId`: the pinned workspace, the only one that holds homes, and a chat with a
 * home. The gateway asks before it opens a chat's object for a note whose row it reached in that workspace
 * (`lib/gatewayRoutes/texChatHome.ts`), so a row elsewhere never points a store at a chat's object.
 */
export const chatHomedIn = internalQuery({
  args: { workspaceId: v.id("workspaces"), chat: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, chat }) => {
    if (!/^[0-9a-f]{64}$/.test(chat)) return false;
    const pinned = await pinnedContextWorkspace(ctx);
    if (pinned === null || pinned._id !== workspaceId) return false;
    const chats = await ctx.db.query("textGroups").withIndex("by_key", (q) => q.eq("groupKey", chat)).take(2);
    return chats.length === 1 && typeof chats[0].homeWords === "string" && chats[0].homeWords !== "";
  },
});
