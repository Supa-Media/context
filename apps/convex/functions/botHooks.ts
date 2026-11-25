/**
 * A bot's webhook: how Context tells a bot that holds an area that mail has
 * arrived for it (`docs/decisions/app-and-console/area-bots.md`, decided by
 * the owner 2026-11-25, sealed like an app connection).
 *
 *   - `setBotHook`: a workspace owner or editor saves the address, an
 *     optional header and the signing key the app made and showed them. All
 *     three are sealed to the workspace here; the first setter or an owner may
 *     replace them later, nobody may read them back.
 *   - `botHookList`: what Settings and the area panel show. Never the address
 *     or a secret: the host, the header's last four characters, who set it and
 *     how the last call went.
 *   - `testBotHook`: the signed-in person asks for one call, an internal
 *     mutation checks them, and `callBotHook` opens the sealed values for that
 *     one signed call, writing the audit line.
 *   - `/gateway/bots/mail`: the workspace object that saved a new line in an
 *     area's mail tells the control plane (`apps/mcp/src/workspaceStore/botMail.js`),
 *     so mail written anywhere reaches the bot, and `authorizeObjectMail`
 *     clears it before the same call.
 *
 * A call says that mail arrived and where: the workspace, the area, the note
 * and who wrote. Never the message itself. The bot reads it through its own
 * Context connection, at its own clearance, and answers there.
 */

import { ConvexError, v } from "convex/values";
import { action, internalAction, internalQuery, query } from "../_generated/server";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { decryptSecret, encryptSecret, requireKeyset } from "./lib/crypto";
import { recordAudit } from "./lib/audit";
import { requireActor } from "./lib/googleConnect/config";
import { getMembership } from "./lib/workspaceAuth";
import { handleForUser } from "./lib/identities";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { dohQuery, RR } from "./lib/customDomains/dns";
import { mailJoinName } from "@context/shared/src/areaBots.cjs";
import { isPrivateAddress, publicHttps } from "@context/shared/src/publicAddress.cjs";
import { HOOK_TIMEOUT_MS, headerLine, hookPayload, signHook, signingKeyShaped, type HookPayload } from "@context/shared/src/botHooks.cjs";

/** Calls one person may start in an hour, tests and mail together. */
export const BOT_CALLS_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;

function refuse(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

/** The bot's name as mail knows it, or a refusal. */
function botName(raw: string): string {
  const name = mailJoinName(raw);
  if (!/[a-z0-9]/i.test(raw)) refuse("BOT_NAME", "Give the bot a name.");
  return name;
}

/** Whether DNS says the host is public, every address it answers. Unanswerable counts as no. */
async function hostIsPublic(host: string): Promise<boolean> {
  const addresses: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    const result = await dohQuery(host, type);
    if (result === null) return false;
    for (const record of result.answer) if (record.type === RR.A || record.type === RR.AAAA) addresses.push(record.data);
  }
  return addresses.length > 0 && addresses.every((address) => !isPrivateAddress(address));
}

/* ------------------------------------------------------------- setting -- */

export const storeBotHook = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    bot: v.string(),
    host: v.string(),
    encryptedUrl: v.string(),
    encryptedHeader: v.optional(v.string()),
    headerEnds: v.optional(v.string()),
    encryptedSigningKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const membership = await getMembership(ctx, args.workspaceId, args.userId);
    if (membership === null || (membership.role !== "owner" && membership.role !== "editor")) {
      refuse("INSUFFICIENT_ROLE", "Only an owner or editor of this workspace can set a bot's webhook.");
    }
    const existing = await ctx.db
      .query("botHooks")
      .withIndex("by_workspace_bot", (q) => q.eq("workspaceId", args.workspaceId).eq("bot", args.bot))
      .unique();
    if (existing !== null && existing.setBy !== args.userId && membership.role !== "owner") {
      refuse("INSUFFICIENT_ROLE", "Only whoever set this webhook, or an owner, can replace it.");
    }
    const row = {
      workspaceId: args.workspaceId,
      bot: args.bot,
      host: args.host,
      encryptedUrl: args.encryptedUrl,
      encryptedHeader: args.encryptedHeader,
      headerEnds: args.headerEnds,
      encryptedSigningKey: args.encryptedSigningKey,
      setBy: args.userId,
      setAt: Date.now(),
    };
    if (existing === null) await ctx.db.insert("botHooks", row);
    else await ctx.db.replace(existing._id, row);
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.userId,
      action: existing === null ? "bot_hook.set" : "bot_hook.replaced",
      details: { bot: args.bot, host: args.host },
    });
    return null;
  },
});

/**
 * Save a bot's webhook. The app made the signing key and showed it to the
 * person before sending it here, so nothing secret is ever answered back.
 */
export const setBotHook = action({
  args: {
    workspaceId: v.id("workspaces"),
    bot: v.string(),
    address: v.string(),
    /** `Name: value`, or empty for none. */
    headerLine: v.optional(v.string()),
    signingKey: v.string(),
  },
  returns: v.object({ host: v.string() }),
  handler: async (ctx, args): Promise<{ host: string }> => {
    const userId = await requireActor(ctx);
    const bot = botName(args.bot);
    const url = publicHttps(args.address);
    if (url === null) refuse("BOT_HOOK_ADDRESS", "Use a public https address, like https://bot.example.com/context.");
    if (args.address.length > 2048) refuse("BOT_HOOK_ADDRESS", "That address is too long.");
    const header = args.headerLine === undefined || args.headerLine.trim() === "" ? null : headerLine(args.headerLine);
    if (header === null && args.headerLine !== undefined && args.headerLine.trim() !== "") {
      refuse("BOT_HOOK_HEADER", "Write the header as Name: value, like Authorization: Bearer abc.");
    }
    if (!signingKeyShaped(args.signingKey)) refuse("BOT_HOOK_KEY", "The signing key is not one Context made.");
    if (!(await hostIsPublic(url.hostname))) refuse("BOT_HOOK_ADDRESS", "That address does not point at a public server.");
    const keyset = requireKeyset();
    const bound = { workspaceId: args.workspaceId as string };
    await ctx.runMutation(internal.functions.botHooks.storeBotHook, {
      workspaceId: args.workspaceId,
      userId,
      bot,
      host: url.hostname,
      encryptedUrl: await encryptSecret(url.href, keyset, bound),
      encryptedHeader: header === null ? undefined : await encryptSecret(`${header.name}: ${header.value}`, keyset, bound),
      headerEnds: header === null ? undefined : header.value.slice(-4),
      encryptedSigningKey: await encryptSecret(args.signingKey, keyset, bound),
    });
    return { host: url.hostname };
  },
});

export const removeBotHook = mutation({
  args: { workspaceId: v.id("workspaces"), bot: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireActor(ctx);
    const membership = await getMembership(ctx, args.workspaceId, userId);
    const row = await ctx.db
      .query("botHooks")
      .withIndex("by_workspace_bot", (q) => q.eq("workspaceId", args.workspaceId).eq("bot", mailJoinName(args.bot)))
      .unique();
    if (membership === null || row === null) return null;
    if (row.setBy !== userId && membership.role !== "owner") {
      refuse("INSUFFICIENT_ROLE", "Only whoever set this webhook, or an owner, can remove it.");
    }
    await ctx.db.delete(row._id);
    await recordAudit(ctx, { workspaceId: args.workspaceId, actorUserId: userId, action: "bot_hook.removed", details: { bot: row.bot } });
    return null;
  },
});

/* ------------------------------------------------------------- showing -- */

const hookRow = v.object({
  bot: v.string(),
  host: v.string(),
  headerEnds: v.union(v.string(), v.null()),
  setByName: v.string(),
  setAt: v.number(),
  lastCallAt: v.union(v.number(), v.null()),
  lastCallOk: v.union(v.boolean(), v.null()),
  lastCallStatus: v.union(v.number(), v.null()),
  /** Whether the viewer may replace or remove it: whoever set it, or an owner. */
  canReplace: v.boolean(),
});

/** A workspace's bot webhooks, for its members. Never an address or a secret. */
export const botHookList = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(hookRow),
  handler: async (ctx, args) => {
    const userId = await requireActor(ctx);
    const membership = await getMembership(ctx, args.workspaceId, userId);
    if (membership === null) return [];
    const rows = await ctx.db
      .query("botHooks")
      .withIndex("by_workspace_bot", (q) => q.eq("workspaceId", args.workspaceId))
      .take(100);
    const out = [];
    for (const row of rows) {
      out.push({
        bot: row.bot,
        host: row.host,
        headerEnds: row.headerEnds ?? null,
        setByName: (await handleForUser(ctx, row.setBy)) ?? "",
        setAt: row.setAt,
        lastCallAt: row.lastCallAt ?? null,
        lastCallOk: row.lastCallOk ?? null,
        lastCallStatus: row.lastCallStatus ?? null,
        canReplace: row.setBy === userId || membership.role === "owner",
      });
    }
    return out;
  },
});

/* ------------------------------------------------------------- calling -- */

/**
 * Who may start a call, checked and spent in one transaction: a member of the
 * workspace, within their hourly allowance, for a bot that has a webhook. A
 * test asks for an owner or editor. Answers what the call may say.
 */
export const authorizeBotCall = internalMutation({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users"), bot: v.string(), kind: v.union(v.literal("test"), v.literal("mail")) },
  returns: v.union(v.null(), v.object({ workspace: v.string(), from: v.string() })),
  handler: async (ctx, args) => {
    const membership = await getMembership(ctx, args.workspaceId, args.userId);
    if (membership === null) return null;
    if (args.kind === "test" && membership.role !== "owner" && membership.role !== "editor") return null;
    const row = await ctx.db
      .query("botHooks")
      .withIndex("by_workspace_bot", (q) => q.eq("workspaceId", args.workspaceId).eq("bot", args.bot))
      .unique();
    if (row === null) return null;
    if (!(await tryConsumeRateLimit(ctx, { key: `bot.call:${args.userId}`, limit: BOT_CALLS_PER_HOUR, windowMs: HOUR_MS }))) {
      refuse("RATE_LIMITED", "That's a lot of calls to bots this hour. Try again later.");
    }
    const workspace = await ctx.db.get(args.workspaceId);
    return { workspace: `@${workspace?.slug ?? ""}`, from: `@${(await handleForUser(ctx, args.userId)) ?? "someone"}` };
  },
});

/** Calls the workspace's own object may start for one bot in an hour. */
export const BOT_MAIL_PER_HOUR = 120;
const NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
const WHO = /^@?[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

/**
 * Mail the workspace object noticed: a bot with a webhook in that workspace,
 * a path that is an area's mail note, within the bot's hourly allowance.
 * Answers the workspace's handle, or null to do nothing.
 */
export const authorizeObjectMail = internalMutation({
  args: { workspaceId: v.string(), bot: v.string(), area: v.string(), note: v.string(), from: v.string() },
  returns: v.union(v.null(), v.object({ workspaceId: v.id("workspaces"), workspace: v.string() })),
  handler: async (ctx, args) => {
    const workspaceId = ctx.db.normalizeId("workspaces", args.workspaceId);
    if (workspaceId === null || !NAME.test(args.bot) || !WHO.test(args.from)) return null;
    if (args.area.length > 512 || !args.note.startsWith(`${args.area}/mail/`) || args.note.length > 512) return null;
    const row = await ctx.db
      .query("botHooks")
      .withIndex("by_workspace_bot", (q) => q.eq("workspaceId", workspaceId).eq("bot", args.bot))
      .unique();
    if (row === null) return null;
    if (!(await tryConsumeRateLimit(ctx, { key: `bot.mail:${workspaceId}:${args.bot}`, limit: BOT_MAIL_PER_HOUR, windowMs: HOUR_MS }))) return null;
    const workspace = await ctx.db.get(workspaceId);
    if (workspace === null) return null;
    return { workspaceId, workspace: `@${workspace.slug}` };
  },
});

export const hookForCall = internalQuery({
  args: { workspaceId: v.id("workspaces"), bot: v.string() },
  returns: v.union(
    v.null(),
    v.object({ id: v.id("botHooks"), encryptedUrl: v.string(), encryptedHeader: v.union(v.string(), v.null()), encryptedSigningKey: v.string() }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("botHooks")
      .withIndex("by_workspace_bot", (q) => q.eq("workspaceId", args.workspaceId).eq("bot", args.bot))
      .unique();
    if (row === null) return null;
    return { id: row._id, encryptedUrl: row.encryptedUrl, encryptedHeader: row.encryptedHeader ?? null, encryptedSigningKey: row.encryptedSigningKey };
  },
});

export const noteBotCall = internalMutation({
  args: { hookId: v.id("botHooks"), actorUserId: v.optional(v.id("users")), kind: v.string(), ok: v.boolean(), status: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.hookId);
    if (row === null) return null;
    await ctx.db.patch(row._id, { lastCallAt: Date.now(), lastCallOk: args.ok, lastCallStatus: args.status });
    // Who called which bot, and whether it answered. Never the address and never what the mail said.
    await recordAudit(ctx, {
      workspaceId: row.workspaceId,
      actorUserId: args.actorUserId,
      action: "bot_hook.called",
      details: { bot: row.bot, kind: args.kind, ok: args.ok, status: args.status },
    });
    return null;
  },
});

const outcome = v.object({ ok: v.boolean(), status: v.number() });
type Outcome = { ok: boolean; status: number };

async function post(url: string, init: RequestInit): Promise<number> {
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(HOOK_TIMEOUT_MS) });
    await response.body?.cancel().catch(() => {});
    return response.status;
  } catch {
    return 0;
  }
}

/**
 * THE BARRIER: opens one bot's sealed address, header and signing key, makes
 * one signed POST (and one retry when the bot could not be reached or failed),
 * and answers only whether it landed and the HTTP status. Its callers are
 * `testBotHook`, which checks the person with `authorizeBotCall` first, and
 * `/gateway/bots/mail`, which `authorizeObjectMail` clears. Redirects are never followed, and the address is
 * checked against DNS again before each call.
 */
export const callBotHook = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    bot: v.string(),
    /** Who asked for a test; absent for mail, which the workspace's own object noticed. */
    actorUserId: v.optional(v.id("users")),
    payload: v.object({
      type: v.union(v.literal("test"), v.literal("mail")),
      workspace: v.string(),
      bot: v.string(),
      from: v.string(),
      area: v.optional(v.string()),
      note: v.optional(v.string()),
    }),
  },
  returns: outcome,
  handler: async (ctx, args): Promise<Outcome> => {
    const hook: { id: Id<"botHooks">; encryptedUrl: string; encryptedHeader: string | null; encryptedSigningKey: string } | null =
      await ctx.runQuery(internal.functions.botHooks.hookForCall, { workspaceId: args.workspaceId, bot: args.bot });
    if (hook === null) return { ok: false, status: 0 };
    const bound = { workspaceId: args.workspaceId as string };
    let address: string;
    let header: { name: string; value: string } | null;
    let key: string;
    try {
      const keyset = requireKeyset();
      address = await decryptSecret(hook.encryptedUrl, keyset, bound);
      header = hook.encryptedHeader === null ? null : headerLine(await decryptSecret(hook.encryptedHeader, keyset, bound));
      key = await decryptSecret(hook.encryptedSigningKey, keyset, bound);
    } catch {
      return { ok: false, status: 0 };
    }
    const url = publicHttps(address);
    let status = 0;
    if (url !== null && (await hostIsPublic(url.hostname))) {
      const body = JSON.stringify(hookPayload(args.payload as HookPayload));
      for (let attempt = 0; attempt < 2; attempt++) {
        const at = String(Math.floor(Date.now() / 1000));
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "user-agent": "Context-Bots/1.0 (+https://context.lc)",
          "x-context-timestamp": at,
          "x-context-signature": `v1=${await signHook(key, at, body)}`,
        };
        if (header !== null) headers[header.name] = header.value;
        status = await post(url.href, { method: "POST", headers, body });
        if (status !== 0 && status < 500) break;
      }
    }
    const ok = status >= 200 && status < 300;
    await ctx.runMutation(internal.functions.botHooks.noteBotCall, { hookId: hook.id, actorUserId: args.actorUserId, kind: args.payload.type, ok, status });
    return { ok, status };
  },
});

/** Send the bot a signed test call, from Settings or the area panel. */
export const testBotHook = action({
  args: { workspaceId: v.id("workspaces"), bot: v.string() },
  returns: outcome,
  handler: async (ctx, args): Promise<Outcome> => {
    const userId = await requireActor(ctx);
    const bot = mailJoinName(args.bot);
    const cleared = await ctx.runMutation(internal.functions.botHooks.authorizeBotCall, { workspaceId: args.workspaceId, userId, bot, kind: "test" });
    if (cleared === null) return { ok: false, status: 0 };
    return await ctx.runAction(internal.functions.botHooks.callBotHook, {
      workspaceId: args.workspaceId,
      bot,
      actorUserId: userId,
      payload: { type: "test", workspace: cleared.workspace, bot, from: cleared.from },
    });
  },
});
