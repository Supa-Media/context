/**
 * Which of a person's Google connections sends their Google Chat messages,
 * and whether they have room for one more (`lib/googleChatSend.ts`,
 * `docs/decisions/communications/google-chat-messages.md`).
 *
 * One mutation, so the check and the spend are one transaction, as
 * `calendarWrite.ts` does: every limit is read first and only then, when all
 * have room, spent together. With `spend: false` it only answers whether the
 * message could go, which the gateway asks before it puts it to the person.
 */

import { v } from "convex/values";
import { internalMutation } from "./lib/rowWatch/mutations";
import type { MutationCtx } from "../_generated/server";
import { recordAudit } from "./lib/audit";
import { ownAccountClearance } from "./lib/controlPlane/ownAccount";
import { personalOwnerReadClearance } from "./lib/controlPlane/personalOwner";
import { CHAT_SEND_SCOPES, chatSendPolicies } from "./lib/googleChatSend";
import { CHAT_READ_SCOPES } from "./lib/googleOAuth";
import type { RateLimitPolicy } from "./lib/rateLimit";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { aiAccessNeeded, aiScopesOf, canReadProduct } from "./lib/googleConnect/aiScopes";

const refusal = v.union(v.literal("not_allowed"), v.literal("no_chat"), v.literal("ai_access_needed"), v.literal("hourly_limit"), v.literal("daily_limit"));

/** Whether this key has room for one more, without spending it. */
async function hasRoom(ctx: MutationCtx, policy: RateLimitPolicy): Promise<boolean> {
  const row = await ctx.db
    .query("rateLimits")
    .withIndex("by_key", (q) => q.eq("key", policy.key))
    .unique();
  if (row === null || Date.now() - row.windowStartedAt >= policy.windowMs) return true;
  return row.count < policy.limit;
}

export const claimChatSend = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.string(),
    to: v.union(v.literal("person"), v.literal("space")),
    spend: v.boolean(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), address: v.string(), connectionId: v.id("googleConnections") }),
    v.object({ ok: v.literal(false), refused: refusal }),
  ),
  handler: async (ctx, args) => {
    // The grant's own person's Chat, from their personal workspace, or a group
    // chat's tagger's (`lib/controlPlane/ownAccount.ts`): an editor grant on a
    // shared workspace never reaches its holder's Chat.
    const cleared = await ownAccountClearance(ctx, {
      hashedAccessToken: args.hashedAccessToken,
      expectedWorkspaceId: args.expectedWorkspaceId,
    });
    if (cleared === null) return { ok: false as const, refused: "not_allowed" as const };
    const personal = cleared.personal;
    const connections = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", personal._id))
      .take(20);
    // Every scope sending needs, granted on one live connection.
    const sender = connections.find(
      (row) => row.disconnectedAt === undefined && CHAT_SEND_SCOPES.every((scope) => aiScopesOf(row).includes(scope)),
    );
    if (sender === undefined) {
      // A Chat account AI may not use until its owner allows AI access is
      // not one a reconnect sets up (`aiAccessNeeded`).
      const waiting = connections.some((row) => row.disconnectedAt === undefined && row.products.includes("chat") && aiAccessNeeded(row));
      return { ok: false as const, refused: waiting ? ("ai_access_needed" as const) : ("no_chat" as const) };
    }
    const policies = chatSendPolicies(cleared.actorUserId);
    for (const policy of policies) {
      if (!(await hasRoom(ctx, policy))) return { ok: false as const, refused: policy.refusal };
    }
    const claimed = { ok: true as const, address: sender.address, connectionId: sender._id };
    if (!args.spend) return claimed;
    for (const policy of policies) {
      // Every one was checked above in this same transaction, so none refuses here.
      await tryConsumeRateLimit(ctx, policy);
    }
    await recordAudit(ctx, {
      workspaceId: personal._id,
      actorUserId: cleared.actorUserId,
      actorClientId: cleared.clientId,
      action: "google_chat_message",
      // Whether to a person or a space, never who or what was said.
      details: { to: args.to },
    });
    return claimed;
  },
});

/** Live reads of a person's Chat an hour: a check-in is three a day, so this only stops a runaway. */
export const CHAT_READ_HOURLY_LIMIT = 30;

/**
 * Which of a person's Google connections reads their Google Chat for Tex's
 * check-ins (`lib/gatewayRoutes/googleChatRead.ts`): the same clearance as a
 * send, a connection that granted reading, and one spend of an hourly limit.
 */
export const claimChatRead = internalMutation({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), address: v.string(), connectionId: v.id("googleConnections") }),
    v.object({ ok: v.literal(false), refused: v.union(v.literal("not_allowed"), v.literal("no_chat"), v.literal("hourly_limit")) }),
  ),
  handler: async (ctx, args) => {
    const cleared = await ownAccountClearance(ctx, args);
    if (cleared === null) return { ok: false as const, refused: "not_allowed" as const };
    const connections = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", cleared.personal._id))
      .take(20);
    const reader = connections.find(
      (row) => row.disconnectedAt === undefined && CHAT_READ_SCOPES.every((scope) => aiScopesOf(row).includes(scope)),
    );
    if (reader === undefined) return { ok: false as const, refused: "no_chat" as const };
    const room = await tryConsumeRateLimit(ctx, {
      key: `chat_read.hour:${cleared.actorUserId}`,
      limit: CHAT_READ_HOURLY_LIMIT,
      windowMs: 60 * 60 * 1000,
    });
    if (!room) return { ok: false as const, refused: "hourly_limit" as const };
    return { ok: true as const, address: reader.address, connectionId: reader._id };
  },
});

/** Reads of one named Chat conversation an hour, per person (`lib/gatewayRoutes/googleChatSpaceRead.ts`). */
export const CHAT_SPACE_READ_HOURLY_LIMIT = 60;

/**
 * Which of a person's Google connections reads one Chat conversation they
 * named, for their own AI: the clearance their live mail reads have
 * (`personMail.ts`), never a send's. The owner of their own personal
 * workspace, on a grant with private access: a Tex group chat's grant, or an
 * editor of somebody's personal workspace, never reads their Chat
 * (owner, 2026-10-21, of group chats: "write only not read"). The connection
 * is one whose AI grant reads Chat; one that waits for its owner to allow AI
 * access says so, since a reconnect would not mend it.
 */
export const claimChatSpaceRead = internalMutation({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), address: v.string(), connectionId: v.id("googleConnections") }),
    v.object({
      ok: v.literal(false),
      refused: v.union(v.literal("not_allowed"), v.literal("no_chat"), v.literal("ai_access_needed"), v.literal("hourly_limit")),
    }),
  ),
  handler: async (ctx, args) => {
    const cleared = await personalOwnerReadClearance(ctx, args);
    if (cleared === null) return { ok: false as const, refused: "not_allowed" as const };
    const connections = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", cleared.workspace._id))
      .take(20);
    const live = connections.filter((row) => row.disconnectedAt === undefined);
    const reader = live.find((row) => canReadProduct("chat", aiScopesOf(row)));
    if (reader === undefined) {
      // Chat comes with a Gmail connect as well as its own, so any account still waiting may be the one.
      const waiting = live.some((row) => aiAccessNeeded(row));
      return { ok: false as const, refused: waiting ? ("ai_access_needed" as const) : ("no_chat" as const) };
    }
    const room = await tryConsumeRateLimit(ctx, {
      key: `chat_space_read.hour:${cleared.userId}`,
      limit: CHAT_SPACE_READ_HOURLY_LIMIT,
      windowMs: 60 * 60 * 1000,
    });
    if (!room) return { ok: false as const, refused: "hourly_limit" as const };
    return { ok: true as const, address: reader.address, connectionId: reader._id };
  },
});
