/**
 * Tex store tickets: the control plane's way into Tex's notes, which live in
 * Durable Objects only the gateway reaches (`lib/texStore.ts`,
 * `apps/mcp/src/texStore/door.js`). See `texStoreTickets` in
 * `lib/schema/jobs.ts`.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

/** How long one ticket opens its workspace's Tex objects. */
export const TEX_STORE_TICKET_TTL_MS = 5 * 60 * 1000;

/** The most owners one ticket names: a workspace's own object and its group chats. */
export const MAX_TICKET_OWNERS = 64;

/** Store one ticket, hashed, and clear this workspace's expired ones. */
export const mint = internalMutation({
  args: { hashedTicket: v.string(), workspaceId: v.id("workspaces"), owners: v.array(v.string()), now: v.number() },
  returns: v.null(),
  handler: async (ctx, { hashedTicket, workspaceId, owners, now }) => {
    // Only this workspace's own object, or its group chats': never another workspace's, of either kind.
    //
    // The gateway's door checks the ticket's owners and nothing else
    // (`apps/mcp/src/texStore/door.js`), so a `chat:` owner's shape is not
    // enough here: the id has to name a chat bound to this workspace, or one
    // workspace's ticket would open another's chat. A chat bound to nobody is
    // nobody's to name.
    // Capped as well as closed: each owner below is a read, and no workspace has this many Tex objects.
    if (owners.length === 0 || owners.length > MAX_TICKET_OWNERS) throw new Error("a Tex store ticket names only this workspace's own objects");
    for (const owner of owners) {
      if (owner === `person:${workspaceId}`) continue;
      const named = /^chat:([A-Za-z0-9_-]{1,64})$/.exec(owner);
      const chatId = named === null ? null : ctx.db.normalizeId("textGroups", named[1]);
      const chat = chatId === null ? null : await ctx.db.get(chatId);
      if (chat === null || chat.workspaceId !== workspaceId) {
        throw new Error("a Tex store ticket names only this workspace's own objects");
      }
    }
    const old = await ctx.db
      .query("texStoreTickets")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .take(20);
    for (const row of old) if (row.expiresAt <= now) await ctx.db.delete(row._id);
    await ctx.db.insert("texStoreTickets", { hashedTicket, workspaceId, owners, createdAt: now, expiresAt: now + TEX_STORE_TICKET_TTL_MS });
    return null;
  },
});

/** What a ticket opens, or `null` when it is unknown or expired. */
export const open = internalQuery({
  args: { hashedTicket: v.string(), now: v.number() },
  returns: v.union(v.null(), v.object({ workspaceId: v.string(), owners: v.array(v.string()) })),
  handler: async (ctx, { hashedTicket, now }) => {
    const row = await ctx.db
      .query("texStoreTickets")
      .withIndex("by_hashed_ticket", (q) => q.eq("hashedTicket", hashedTicket))
      .unique();
    if (row === null || row.expiresAt <= now) return null;
    return { workspaceId: row.workspaceId, owners: row.owners };
  },
});
