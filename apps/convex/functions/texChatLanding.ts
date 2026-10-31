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
