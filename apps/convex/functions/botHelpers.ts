/**
 * A bot's helpers (`lib/schema/botHelpers.ts`; `docs/decisions/app-and-console/bot-helpers.md`): the sessions a bot
 * starts for deep work, each reaching Context as that bot's sub-agent with a short-lived token of its own.
 *
 * What a helper's token can do: act as the bot's own grant did (the same person, the same workspaces, the same role),
 * shown as "<name> via <bot>", until it ends, its time runs out (at most a day) or the bot's grant is revoked. It can't
 * clear as an owner or editor (`resolveLiveGrant` never resolves it), so it sets no webhook, binds no bot and starts no
 * helper of its own. Starting one needs an owner's or an editor's connection, as binding a bot does.
 */

import { v } from "convex/values";
import { internalMutation } from "./lib/rowWatch/mutations";
import { getMembership } from "./lib/workspaceAuth";
import { resolveLiveGrant, validateLiveGrantRecord } from "./lib/controlPlane/liveGrants";
import { mayParentHelper } from "./lib/controlPlane/helperGrants";
import { TOKEN_HASH_PATTERN } from "./lib/crypto";

export const BOT_HELPER_TICKET_TTL_MS = 10 * 60 * 1000;
/** A helper's longest life. Its note says how long it was given; a longer job starts a new helper. */
export const BOT_HELPER_MAX_MS = 24 * 60 * 60 * 1000;
export const BOT_HELPER_DEFAULT_MS = 8 * 60 * 60 * 1000;
/** Helpers one bot's grant may have at once, claimed or not. */
export const BOT_HELPERS_PER_GRANT = 8;
export const HELPER_ID_PATTERN = /^hlp_[0-9a-f]{16}$/;
const MAIL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PURGE_BATCH = 100;

const text = (raw: string, max: number) => raw.replace(/[\r\n]+/g, " ").trim().slice(0, max);

export const startBotHelper = internalMutation({
  args: {
    hashedParentToken: v.string(),
    hashedTicket: v.string(),
    workspaceId: v.id("workspaces"),
    helperId: v.string(),
    bot: v.string(),
    botName: v.string(),
    name: v.string(),
    mail: v.string(),
    note: v.string(),
    ms: v.optional(v.number()),
  },
  returns: v.union(v.object({ error: v.string() }), v.object({ expiresAt: v.number(), ticketExpiresAt: v.number() })),
  handler: async (ctx, args) => {
    if (!TOKEN_HASH_PATTERN.test(args.hashedTicket) || !HELPER_ID_PATTERN.test(args.helperId) || !MAIL_NAME.test(args.mail) || !MAIL_NAME.test(args.bot)) {
      return { error: "That helper's name or id isn't valid." };
    }
    if (!/^(?:[^\s]{1,200}\/)?bots\/[a-z0-9][a-z0-9-]{0,39}\/helpers\/[^\s/]{1,200}\.md$/.test(args.note) || args.note.includes("/../")) return { error: "A helper's note lives in its bot's helpers folder." };
    const parent = await resolveLiveGrant(ctx, args.hashedParentToken);
    if (parent === null || !mayParentHelper(parent.grant.clientId)) return { error: "Only a bot's own connection starts a helper." };
    const membership = await getMembership(ctx, args.workspaceId, parent.grant.userId);
    if (membership === null || (membership.role !== "owner" && membership.role !== "editor")) {
      return { error: "Only an owner's or an editor's bot starts helpers here." };
    }
    const now = Date.now();
    const mine = await ctx.db
      .query("botHelpers")
      .withIndex("by_parent", (q) => q.eq("parentGrantId", parent.grant._id))
      .collect();
    const live = mine.filter((row) => row.expiresAt > now && (row.hashedAccessToken !== undefined || row.ticketExpiresAt > now));
    for (const row of mine) if (!live.includes(row)) await ctx.db.delete(row._id);
    if (live.length >= BOT_HELPERS_PER_GRANT) return { error: `This bot already has ${BOT_HELPERS_PER_GRANT} helpers running. End one with end_helper first.` };
    const asked = typeof args.ms === "number" && Number.isFinite(args.ms) && args.ms > 0 ? args.ms : BOT_HELPER_DEFAULT_MS;
    const expiresAt = now + Math.min(asked, BOT_HELPER_MAX_MS);
    const ticketExpiresAt = now + BOT_HELPER_TICKET_TTL_MS;
    await ctx.db.insert("botHelpers", {
      helperId: args.helperId,
      parentGrantId: parent.grant._id,
      workspaceId: args.workspaceId,
      bot: args.bot,
      botName: text(args.botName, 60) || args.bot,
      name: text(args.name, 40) || "Helper",
      mail: args.mail,
      note: args.note,
      hashedTicket: args.hashedTicket,
      ticketExpiresAt,
      expiresAt,
      createdAt: now,
    });
    return { expiresAt, ticketExpiresAt };
  },
});

/** Spends a helper's ticket and keeps its new token's hash: `{helperId, expiresAt}`, or null for unknown, lapsed or spent. */
export const claimBotHelper = internalMutation({
  args: { hashedTicket: v.string(), hashedAccessToken: v.string() },
  returns: v.union(v.null(), v.object({ helperId: v.string(), expiresAt: v.number() })),
  handler: async (ctx, args) => {
    if (!TOKEN_HASH_PATTERN.test(args.hashedTicket) || !TOKEN_HASH_PATTERN.test(args.hashedAccessToken)) return null;
    const row = await ctx.db
      .query("botHelpers")
      .withIndex("by_ticket", (q) => q.eq("hashedTicket", args.hashedTicket))
      .unique();
    const now = Date.now();
    if (row === null || row.hashedAccessToken !== undefined || row.ticketExpiresAt <= now || row.expiresAt <= now) return null;
    // The bot's grant must still be live when its ticket is spent: a revoked connection's ticket starts nothing.
    const parent = await ctx.db.get(row.parentGrantId);
    if (parent === null || !mayParentHelper(parent.clientId)) return null;
    if ((await validateLiveGrantRecord(ctx, { ...parent, accessTokenExpiresAt: row.expiresAt })) === null) return null;
    await ctx.db.patch(row._id, { hashedTicket: undefined, hashedAccessToken: args.hashedAccessToken });
    return { helperId: row.helperId, expiresAt: row.expiresAt };
  },
});

/**
 * Ends a helper: by its own token, or by its bot's own grant. Deletes the row, so its token stops on the next request.
 * `{bot, mail, note, name, botName}` of the one ended, or null when the token may not end it (or it is already gone).
 */
export const endBotHelper = internalMutation({
  args: { helperId: v.string(), hashedAccessToken: v.string() },
  returns: v.union(v.null(), v.object({ bot: v.string(), botName: v.string(), name: v.string(), mail: v.string(), note: v.string() })),
  handler: async (ctx, args) => {
    if (!HELPER_ID_PATTERN.test(args.helperId) || !TOKEN_HASH_PATTERN.test(args.hashedAccessToken)) return null;
    const row = await ctx.db
      .query("botHelpers")
      .withIndex("by_helper", (q) => q.eq("helperId", args.helperId))
      .unique();
    if (row === null) return null;
    const own = row.hashedAccessToken === args.hashedAccessToken;
    const parent = own ? null : await resolveLiveGrant(ctx, args.hashedAccessToken);
    if (!own && (parent === null || parent.grant._id !== row.parentGrantId)) return null;
    await ctx.db.delete(row._id);
    return { bot: row.bot, botName: row.botName, name: row.name, mail: row.mail, note: row.note };
  },
});

/** Hourly: helpers past their time go, and their tokens with them (a lapsed token is already refused). */
export const purgeExpiredBotHelpers = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("botHelpers")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
      .take(PURGE_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    return { deleted: rows.length };
  },
});
