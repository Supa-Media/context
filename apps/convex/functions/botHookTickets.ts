/**
 * A bot hands Context its webhook's header from its own shell (the owner,
 * 2026-11-25: a Grok bot "can't see the secret", it only has it in an
 * environment variable). The secret never passes through a model or a chat:
 *
 *   1. `manage area` with `webhook.header_from_shell` asks `/gateway/bots/hook`
 *      for a ticket (`action: "ticket"`), cleared as an editor like `set`. The
 *      address and header name are checked and kept with the ticket; the
 *      ticket comes back once, and only its hash is stored.
 *   2. The bot runs the curl command the answer gives it: `PUT /api/bot-hook`
 *      on the gateway with the ticket in `Authorization` and the header's value
 *      (`Bearer $SECRET`) as the body.
 *   3. The gateway posts both here (`/gateway/bots/hook-ticket`, its secret
 *      only). The ticket is spent, the person who minted it is cleared again
 *      with the same token, and the webhook is sealed exactly as `set` seals
 *      it, with a signing key nobody sees.
 *
 * What a ticket can do: once, within ten minutes, set the header of the one
 * webhook it names (bot, address and header name fixed at minting), while the
 * grant that minted it is still live and its person can still edit there.
 * Somebody who learns it can only point that one header at a value of their
 * choosing, which the next `set` replaces; it reads nothing back.
 */

import { v } from "convex/values";
import { internalMutation } from "./lib/rowWatch/mutations";
import { getMembership } from "./lib/workspaceAuth";
import { mailJoinName } from "@context/shared/src/areaBots.cjs";
import { publicHttps } from "@context/shared/src/publicAddress.cjs";

export const BOT_HOOK_TICKET_TTL_MS = 10 * 60 * 1000;
/** A header's name: letters, digits and dashes, as HTTP allows. */
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export const mintBotHookTicket = internalMutation({
  args: {
    hashedTicket: v.string(),
    hashedAccessToken: v.string(),
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    bot: v.string(),
    address: v.string(),
    headerName: v.string(),
  },
  returns: v.union(v.null(), v.object({ error: v.string() })),
  handler: async (ctx, args) => {
    const bot = mailJoinName(args.bot);
    if (!/[a-z0-9]/i.test(args.bot)) return { error: "Give the bot a name." };
    if (args.address.length > 2048 || publicHttps(args.address) === null) return { error: "Use a public https address, like https://bot.example.com/context." };
    if (!HEADER_NAME_PATTERN.test(args.headerName)) return { error: "header_from_shell is the header's name, like Authorization." };
    const membership = await getMembership(ctx, args.workspaceId, args.userId);
    if (membership === null || (membership.role !== "owner" && membership.role !== "editor")) {
      return { error: "Only an owner or editor of this workspace can set a bot's webhook." };
    }
    const existing = await ctx.db
      .query("botHooks")
      .withIndex("by_workspace_bot", (q) => q.eq("workspaceId", args.workspaceId).eq("bot", bot))
      .unique();
    if (existing !== null && existing.setBy !== args.userId && membership.role !== "owner") {
      return { error: "Only whoever set this webhook, or an owner, can replace it." };
    }
    const now = Date.now();
    // Spent and lapsed tickets of this workspace go as new ones come.
    const old = await ctx.db
      .query("botHookTickets")
      .withIndex("by_workspace_expires", (q) => q.eq("workspaceId", args.workspaceId).lt("expiresAt", now))
      .take(20);
    for (const row of old) await ctx.db.delete(row._id);
    await ctx.db.insert("botHookTickets", {
      hashedTicket: args.hashedTicket,
      hashedAccessToken: args.hashedAccessToken,
      workspaceId: args.workspaceId,
      userId: args.userId,
      bot,
      address: args.address,
      headerName: args.headerName,
      expiresAt: now + BOT_HOOK_TICKET_TTL_MS,
    });
    return null;
  },
});

/** Spends a ticket: what it was minted for, or null for unknown, lapsed and spent alike. */
export const spendBotHookTicket = internalMutation({
  args: { hashedTicket: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      hashedAccessToken: v.string(),
      workspaceId: v.id("workspaces"),
      userId: v.id("users"),
      bot: v.string(),
      address: v.string(),
      headerName: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("botHookTickets")
      .withIndex("by_hashed_ticket", (q) => q.eq("hashedTicket", args.hashedTicket))
      .unique();
    if (row === null || row.usedAt !== undefined || row.expiresAt <= Date.now()) return null;
    await ctx.db.patch(row._id, { usedAt: Date.now() });
    return {
      hashedAccessToken: row.hashedAccessToken,
      workspaceId: row.workspaceId,
      userId: row.userId,
      bot: row.bot,
      address: row.address,
      headerName: row.headerName,
    };
  },
});
