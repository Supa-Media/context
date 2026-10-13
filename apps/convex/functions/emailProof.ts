import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "./lib/crypto";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { sendAccountMail } from "./lib/accountMail";
import {
  confirmedEmailsOf,
  EMAIL_PROOF_WINDOW_MS,
  hasEmailProof,
  liveSessionOf,
  maskEmail,
  requireEmailProof,
  signOutSession,
  signOutSessions,
} from "./lib/emailProof";

/**
 * "Check it's you" (board k2): the session mails itself a code at one of the
 * person's own confirmed emails and types it back, which lets it make big
 * changes for fifteen minutes. See `lib/emailProof.ts` for what counts as a
 * big change and why the proof is per session.
 */

const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_WRONG_TRIES = 5;
/** Codes mailed per person per hour. */
const SEND_LIMIT = 5;
const WINDOW_MS = 60 * 60 * 1000;

function requireSignedIn(userId: Id<"users"> | null): Id<"users"> {
  if (userId === null) throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  return userId;
}

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(bytes[0] % 10 ** CODE_LENGTH).padStart(CODE_LENGTH, "0");
}

/** Whether this session may make big changes now, and where a code can go. */
export const myEmailProof = query({
  args: {},
  returns: v.object({ proven: v.boolean(), emails: v.array(v.string()) }),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { proven: false, emails: [] };
    return {
      proven: await hasEmailProof(ctx, userId),
      emails: (await confirmedEmailsOf(ctx, userId)).map(maskEmail),
    };
  },
});

export const prepareCode = internalMutation({
  args: { userId: v.id("users"), sessionId: v.id("authSessions"), to: v.number(), hashedCode: v.string() },
  returns: v.union(
    v.object({ status: v.literal("ok"), email: v.string() }),
    v.object({ status: v.union(v.literal("no_email"), v.literal("too_many"), v.literal("signed_out")) }),
  ),
  handler: async (ctx, { userId, sessionId, to, hashedCode }) => {
    if ((await liveSessionOf(ctx, userId)) !== sessionId) return { status: "signed_out" as const };
    const emails = await confirmedEmailsOf(ctx, userId);
    const email = emails[to];
    if (email === undefined) return { status: "no_email" as const };
    if (!(await tryConsumeRateLimit(ctx, { key: `emailProof.send:${userId}`, limit: SEND_LIMIT, windowMs: WINDOW_MS }))) {
      return { status: "too_many" as const };
    }
    const old = await ctx.db
      .query("emailProofCodes")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .take(10);
    for (const row of old) await ctx.db.delete(row._id);
    await ctx.db.insert("emailProofCodes", {
      userId,
      sessionId,
      email,
      hashedCode,
      expiresAt: Date.now() + CODE_TTL_MS,
      wrongTries: 0,
    });
    return { status: "ok" as const, email };
  },
});

/** Mail a code to one of this person's own emails (`to` indexes `myEmailProof.emails`). */
export const startEmailProof = action({
  args: { to: v.optional(v.number()) },
  returns: v.object({ status: v.string(), sentTo: v.optional(v.string()) }),
  handler: async (ctx, args): Promise<{ status: string; sentTo?: string }> => {
    const userId = requireSignedIn((await getAuthUserId(ctx)) as Id<"users"> | null);
    const sessionId = await ctx.runQuery(internal.functions.emailProof.sessionFor, { userId });
    if (sessionId === null) return { status: "signed_out" };
    const code = newCode();
    const prepared = await ctx.runMutation(internal.functions.emailProof.prepareCode, {
      userId,
      sessionId,
      to: args.to ?? 0,
      hashedCode: await hashToken(code),
    });
    if (prepared.status !== "ok") return { status: prepared.status };
    await ctx.scheduler.runAfter(0, internal.functions.emailProof.mailCode, { email: prepared.email, code });
    return { status: "sent", sentTo: maskEmail(prepared.email) };
  },
});

export const mailCode = internalAction({
  args: { email: v.string(), code: v.string() },
  returns: v.null(),
  handler: async (_ctx, { email, code }) => {
    await sendAccountMail("email_proof_code", {
      to: email,
      subject: `${code} is your Context code`,
      text:
        `${code} is your code to confirm a change to your Context account.\n\n` +
        `It expires in ten minutes. If you didn't ask for it, someone may be signed in with your phone number: ` +
        `open Context, go to Account › Signed in and sign out the devices you don't know, then call your carrier.`,
    });
    return null;
  },
});

/** This request's live session, for the actions above (they cannot read the database). */
export const sessionFor = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(v.id("authSessions"), v.null()),
  handler: async (ctx, { userId }) => await liveSessionOf(ctx, userId),
});

export const consumeCode = internalMutation({
  args: { userId: v.id("users"), sessionId: v.id("authSessions"), hashedCode: v.string() },
  returns: v.union(v.literal("confirmed"), v.literal("wrong"), v.literal("expired")),
  handler: async (ctx, { userId, sessionId, hashedCode }) => {
    if ((await liveSessionOf(ctx, userId)) !== sessionId) return "expired";
    const row = await ctx.db
      .query("emailProofCodes")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    if (row === null || row.userId !== userId) return "expired";
    if (row.expiresAt <= Date.now()) {
      await ctx.db.delete(row._id);
      return "expired";
    }
    if (row.hashedCode !== hashedCode) {
      if (row.wrongTries + 1 >= MAX_WRONG_TRIES) await ctx.db.delete(row._id);
      else await ctx.db.patch(row._id, { wrongTries: row.wrongTries + 1 });
      return "wrong";
    }
    await ctx.db.delete(row._id);
    // The address may have been removed since the code was mailed.
    if (!(await confirmedEmailsOf(ctx, userId)).includes(row.email)) return "expired";
    const old = await ctx.db
      .query("emailProofs")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .take(10);
    for (const proof of old) await ctx.db.delete(proof._id);
    await ctx.db.insert("emailProofs", { userId, sessionId, until: Date.now() + EMAIL_PROOF_WINDOW_MS });
    return "confirmed";
  },
});

/** Type back the mailed code. */
export const confirmEmailProof = action({
  args: { code: v.string() },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args): Promise<{ status: string }> => {
    const userId = requireSignedIn((await getAuthUserId(ctx)) as Id<"users"> | null);
    const code = args.code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) return { status: "wrong" };
    const sessionId = await ctx.runQuery(internal.functions.emailProof.sessionFor, { userId });
    if (sessionId === null) return { status: "expired" };
    const status = await ctx.runMutation(internal.functions.emailProof.consumeCode, {
      userId,
      sessionId,
      hashedCode: await hashToken(code),
    });
    return { status };
  },
});

// ── Signed in (board k3's footer) ──────────────────────────────────────────

/** The devices signed in to this account: when each started, and which is this one. */
export const mySessions = query({
  args: {},
  returns: v.array(v.object({ id: v.id("authSessions"), signedInAt: v.number(), current: v.boolean() })),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const current = await liveSessionOf(ctx, userId);
    const now = Date.now();
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .take(100);
    return sessions
      .filter((session) => session.expirationTime > now)
      .sort((a, b) => b._creationTime - a._creationTime)
      .map((session) => ({ id: session._id, signedInAt: session._creationTime, current: session._id === current }));
  },
});

/** Sign out one other device, or every other device. A big change: it can lock somebody out. */
export const signOutOthers = mutation({
  args: { session: v.optional(v.id("authSessions")) },
  returns: v.object({ signedOut: v.number() }),
  handler: async (ctx, args) => {
    const userId = requireSignedIn(await getAuthUserId(ctx));
    await requireEmailProof(ctx, userId);
    const current = await liveSessionOf(ctx, userId);
    if (args.session === undefined) return { signedOut: await signOutSessions(ctx, userId, current) };
    const target = await ctx.db.get(args.session);
    if (target === null || target.userId !== userId || target._id === current) return { signedOut: 0 };
    await signOutSession(ctx, target._id);
    return { signedOut: 1 };
  },
});

// ── For actions ────────────────────────────────────────────────────────────

/**
 * `requireEmailProof` for an action, which cannot read the database itself.
 * The caller's identity travels with `ctx.runQuery`, so this reads the same
 * session the action was called from.
 */
export const requireProof = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = requireSignedIn(await getAuthUserId(ctx));
    await requireEmailProof(ctx, userId);
    return null;
  },
});

/** Rebinding storage a workspace already has is a big change; binding new storage is not. */
export const requireProofToRebind = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    const userId = requireSignedIn(await getAuthUserId(ctx));
    const existing = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (existing !== null) await requireEmailProof(ctx, userId);
    return null;
  },
});
