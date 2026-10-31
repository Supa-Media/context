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

/** Store one ticket, hashed, and clear this workspace's expired ones. */
export const mint = internalMutation({
  args: { hashedTicket: v.string(), workspaceId: v.id("workspaces"), owners: v.array(v.string()), now: v.number() },
  returns: v.null(),
  handler: async (ctx, { hashedTicket, workspaceId, owners, now }) => {
    // Only this workspace's own object, or its group chats' (`chat:`): never another person's.
    if (owners.length === 0 || owners.some((owner) => owner !== `person:${workspaceId}` && !/^chat:[A-Za-z0-9_-]{1,64}$/.test(owner))) {
      throw new Error("a Tex store ticket names only this workspace's own objects");
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
