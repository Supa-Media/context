/**
 * A bot's login, bound to its card, and whether it answers (Dev, 2026-11-26: "At connect time Context should bind
 * the bot's connector login to its bot card, so anything that login writes shows as Grok Bot ... instead of Cursor",
 * and "Context sends one test mail as the last step and marks the connection healthy only when the reply comes from
 * the bot's own identity within a few minutes").
 *
 *   - `bindBotLogin`: the bot's own connection says which bot it is in one workspace (`manage area { bind_bot }`),
 *     cleared as an owner or editor there. It is kept on the grant (`oauthGrants.bots`), so revoking the connection
 *     unbinds it, and the check starts: `checkSentAt` now, no answer yet.
 *   - `botAnswered`: the gateway saw that bound login send mail in that workspace (`apps/mcp/src/tools/notes/mail.js`).
 *   - `botHealthOf`: answering, checking, or not answering, worked out when read.
 *
 * Names only: no address, no key, no message.
 */

import { v } from "convex/values";
import { internalQuery, type QueryCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import type { Id } from "../_generated/dataModel";
import { contextsForGrant, resolveLiveGrant } from "./lib/controlPlane/liveGrants";
import { gatewayEditorClearance } from "./lib/controlPlane/session";
import { TOKEN_HASH_PATTERN } from "./lib/crypto";
import { recordAudit } from "./lib/audit";
import { mailJoinName } from "@context/shared/src/areaBots.cjs";

/** How long a bot has to answer the check before its card says it is not answering. */
export const BOT_CHECK_MS = 5 * 60 * 1000;
/** The most workspaces one login may be a bot in. */
const MAX_BOUND = 20;

export type BotHealth = "answering" | "checking" | "not answering";

/** What a health row says now. */
export function healthOf(row: { checkSentAt: number; answeredAt?: number } | null, now: number): BotHealth | null {
  if (row === null) return null;
  if (row.answeredAt !== undefined && row.answeredAt >= row.checkSentAt) return "answering";
  return now - row.checkSentAt < BOT_CHECK_MS ? "checking" : "not answering";
}

async function healthRow(ctx: QueryCtx, workspaceId: Id<"workspaces">, bot: string) {
  return await ctx.db
    .query("botHealth")
    .withIndex("by_workspace_bot", (q) => q.eq("workspaceId", workspaceId).eq("bot", bot))
    .unique();
}

export const bindBotLogin = internalMutation({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string(), bot: v.string(), name: v.string() },
  returns: v.union(v.object({ ok: v.literal(true), workspaceId: v.id("workspaces"), bot: v.string() }), v.object({ error: v.string() })),
  handler: async (ctx, args) => {
    if (!TOKEN_HASH_PATTERN.test(args.hashedAccessToken)) return { error: "refused" };
    const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
    // A Tex group chat's grant is the chat's, never a bot.
    if (live === null || live.grant.texGroup !== undefined) return { error: "Only a bot's own Context connection can say which bot it is." };
    const workspaceId = gatewayEditorClearance({ scopes: live.grant.scopes, workspaces: await contextsForGrant(ctx, live) }, args.expectedWorkspaceId);
    if (workspaceId === null) return { error: "Only an owner or editor of this workspace can set up its bots." };
    const bot = mailJoinName(args.bot);
    const name = args.name.trim().slice(0, 64);
    if (!/[a-z0-9]/.test(bot) || name === "") return { error: "Name the bot as its card names it." };
    const others = (live.grant.bots ?? []).filter((entry) => entry.workspaceId !== workspaceId);
    if (others.length >= MAX_BOUND) return { error: "This connection is already a bot in too many workspaces." };
    await ctx.db.patch(live.grant._id, { bots: [...others, { workspaceId, bot, name }] });
    const now = Date.now();
    const row = await healthRow(ctx, workspaceId, bot);
    if (row === null) await ctx.db.insert("botHealth", { workspaceId, bot, checkSentAt: now });
    else await ctx.db.patch(row._id, { checkSentAt: now, answeredAt: undefined });
    await recordAudit(ctx, {
      workspaceId,
      actorUserId: live.grant.userId,
      actorClientId: live.grant.clientId,
      action: "bot_login.bound",
      details: { bot },
    });
    return { ok: true as const, workspaceId, bot };
  },
});

/**
 * A bound login sent mail. Cleared with that login's own token: only a grant bound as this bot in this workspace
 * moves its health, so nobody else can mark a bot as answering.
 */
export const botAnswered = internalMutation({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!TOKEN_HASH_PATTERN.test(args.hashedAccessToken)) return null;
    const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
    const bound = live?.grant.bots?.find((entry) => entry.workspaceId === args.expectedWorkspaceId);
    if (live === null || bound === undefined) return null;
    const workspaceId = bound.workspaceId;
    const row = await healthRow(ctx, workspaceId, bound.bot);
    if (row === null) return null;
    // Once per check is enough: later answers change nothing anyone reads.
    if (row.answeredAt !== undefined && row.answeredAt >= row.checkSentAt) return null;
    await ctx.db.patch(row._id, { answeredAt: Date.now() });
    return null;
  },
});

/** Every bot's health in a workspace, for its members: `{ bot, health, checkSentAt }`. */
export async function botHealthRows(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
  const rows = await ctx.db
    .query("botHealth")
    .withIndex("by_workspace_bot", (q) => q.eq("workspaceId", workspaceId))
    .take(100);
  const now = Date.now();
  return rows.map((row) => ({ bot: row.bot, health: healthOf(row, now)!, checkSentAt: row.checkSentAt }));
}

export const botHealthOf = internalQuery({
  args: { workspaceId: v.id("workspaces"), bot: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => healthOf(await healthRow(ctx, args.workspaceId, mailJoinName(args.bot)), Date.now()),
});
