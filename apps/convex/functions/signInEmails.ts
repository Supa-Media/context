import { getAuthUserId } from "@convex-dev/auth/server";
import { MAGIC_LINK_PROVIDER_ID } from "@supa-media/convex/auth";
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "./lib/crypto";
import { foldIn, ownsAnything } from "./lib/account/foldIn";
import { parseInvitee } from "./lib/invitees";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { accountsForEmail, attachedEmailsOf, MAX_EMAILS_PER_ACCOUNT } from "./lib/signInEmails";

/**
 * Several sign-in emails on one account (Dev2, 2026-10-09).
 *
 * Adding one mails a six-digit code to it; typing the code back attaches it.
 * From then on that address signs in to this account (`auth.ts`,
 * `findUserByEmail`), and anything shared with it or invitations sent to it
 * reach this person (`lib/identities.ts`).
 *
 * ## An address that already has its own account (option C)
 *
 * Accounts are never joined: two accounts each own a personal workspace, and
 * a person with two personal workspaces is the mess Dev2 ruled out. So:
 *
 *  - If the other account **owns no workspace** — somebody who only ever
 *    joined other people's, which is what signing in once with a work email
 *    produces — confirming the code moves its memberships here and closes it.
 *    Shares and invitations addressed to the email follow the email.
 *  - If it owns anything, the address is refused before a code is sent.
 *
 * The code is the consent: only somebody who reads that mailbox can close the
 * account behind it, which is exactly who could sign in to it anyway.
 */

const CODE_LENGTH = 6;
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_WRONG_TRIES = 5;
/** Codes mailed per person per hour, and to one address per hour. */
const SEND_LIMIT = 5;
const ADDRESS_SEND_LIMIT = 3;
const WINDOW_MS = 60 * 60 * 1000;
/** Auth providers an email signs in through; their accounts are keyed by the address. */
const EMAIL_PROVIDERS = ["email", MAGIC_LINK_PROVIDER_ID];

type StartStatus =
  | "sent"
  | "invalid_email"
  | "already_yours"
  | "has_own_workspace"
  | "too_many_emails"
  | "too_many";
type ConfirmStatus = "added" | "wrong" | "expired" | "has_own_workspace" | "too_many";

function requireSignedIn(userId: Id<"users"> | null): Id<"users"> {
  if (userId === null) throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  return userId;
}

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(bytes[0] % 10 ** CODE_LENGTH).padStart(CODE_LENGTH, "0");
}

/**
 * What adding `email` to `userId` would mean: theirs already, free, or held
 * by another account that can or cannot be folded in.
 */
async function standingOf(
  ctx: QueryCtx,
  userId: Id<"users">,
  email: string,
): Promise<{ kind: "mine" } | { kind: "free" } | { kind: "other"; otherId: Id<"users"> } | { kind: "blocked" }> {
  // Unverified rows too: an address sitting unverified on another account is
  // still that account's, and attaching it here would make it ambiguous.
  const holders = await accountsForEmail(ctx, email, { verifiedOnly: false });
  if (holders.includes(userId)) return { kind: "mine" };
  if (holders.length === 0) return { kind: "free" };
  if (holders.length > 1) return { kind: "blocked" };
  return (await ownsAnything(ctx, holders[0])) ? { kind: "blocked" } : { kind: "other", otherId: holders[0] };
}

// ── Reading ────────────────────────────────────────────────────────────────

/** This person's sign-in emails. The first is where mail goes. */
export const myEmails = query({
  args: {},
  returns: v.array(v.object({ email: v.string(), mail: v.boolean() })),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const user = await ctx.db.get(userId);
    if (user === null) return [];
    const emails: { email: string; mail: boolean }[] = [];
    if (user.email !== undefined) emails.push({ email: user.email.toLowerCase(), mail: true });
    for (const email of await attachedEmailsOf(ctx, userId)) emails.push({ email, mail: false });
    return emails;
  },
});

// ── Adding ─────────────────────────────────────────────────────────────────

export const prepareCode = internalMutation({
  args: { userId: v.id("users"), email: v.string(), hashedCode: v.string() },
  returns: v.union(
    v.literal("ok"),
    v.literal("already_yours"),
    v.literal("has_own_workspace"),
    v.literal("too_many_emails"),
    v.literal("too_many"),
  ),
  handler: async (ctx, { userId, email, hashedCode }) => {
    const standing = await standingOf(ctx, userId, email);
    if (standing.kind === "mine") return "already_yours";
    if (standing.kind === "blocked") return "has_own_workspace";
    if ((await attachedEmailsOf(ctx, userId)).length >= MAX_EMAILS_PER_ACCOUNT) return "too_many_emails";
    if (!(await tryConsumeRateLimit(ctx, { key: `signInEmail.send:${userId}`, limit: SEND_LIMIT, windowMs: WINDOW_MS }))) {
      return "too_many";
    }
    if (!(await tryConsumeRateLimit(ctx, { key: `signInEmail.sendTo:${email}`, limit: ADDRESS_SEND_LIMIT, windowMs: WINDOW_MS }))) {
      // Throwing rolls back the per-person spend above with it.
      throw new ConvexError({ code: "RATE_LIMITED", message: "too_many" });
    }
    // One live code per person: a new one replaces the last.
    const old = await ctx.db
      .query("signInEmailCodes")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(10);
    for (const row of old) await ctx.db.delete(row._id);
    await ctx.db.insert("signInEmailCodes", {
      userId,
      email,
      hashedCode,
      expiresAt: Date.now() + EMAIL_CODE_TTL_MS,
      wrongTries: 0,
    });
    return "ok";
  },
});

/** Mail a code to an address this person wants to sign in with. */
export const startAddEmail = action({
  args: { email: v.string() },
  returns: v.object({ status: v.string(), email: v.optional(v.string()) }),
  handler: async (ctx, args): Promise<{ status: StartStatus; email?: string }> => {
    const userId = requireSignedIn((await getAuthUserId(ctx)) as Id<"users"> | null);
    const parsed = parseInvitee(args.email);
    if (!parsed.ok || parsed.invitee.kind !== "email") return { status: "invalid_email" };
    const email = parsed.invitee.value;
    const code = newCode();
    let prepared: Exclude<StartStatus, "sent" | "invalid_email"> | "ok";
    try {
      prepared = await ctx.runMutation(internal.functions.signInEmails.prepareCode, {
        userId,
        email,
        hashedCode: await hashToken(code),
      });
    } catch (error) {
      if (error instanceof ConvexError && (error.data as { code?: string }).code === "RATE_LIMITED") {
        return { status: "too_many" };
      }
      throw error;
    }
    if (prepared !== "ok") return { status: prepared };
    await ctx.scheduler.runAfter(0, internal.functions.signInEmails.mailCode, { email, code });
    return { status: "sent", email };
  },
});

/**
 * Mail the code. With no Resend key (tests, a self-host without mail) it does
 * nothing and logs that, without the address.
 */
export const mailCode = internalAction({
  args: { email: v.string(), code: v.string() },
  returns: v.null(),
  handler: async (_ctx, { email, code }) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      console.log(JSON.stringify({ event: "sign_in_email_code_skipped", reason: "resend_unconfigured" }));
      return null;
    }
    const text =
      `${code} is your code to add this email to your Context account.\n\n` +
      `It expires in ten minutes. If you didn't ask for it, ignore this email: nothing changes without the code.`;
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.AUTH_EMAIL_FROM ?? "auth@context.lc",
          to: email,
          subject: `${code} is your Context code`,
          text,
        }),
      });
      // The status only: Resend's error body quotes the address.
      console.log(JSON.stringify({ event: "sign_in_email_code", ok: response.ok, status: response.status }));
    } catch {
      console.log(JSON.stringify({ event: "sign_in_email_code", ok: false, reason: "transport_error" }));
    }
    return null;
  },
});

export const codeFor = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(
    v.null(),
    v.object({ email: v.string(), hashedCode: v.string(), expiresAt: v.number(), wrongTries: v.number() }),
  ),
  handler: async (ctx, { userId }) => {
    const row = await ctx.db
      .query("signInEmailCodes")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    return row === null
      ? null
      : { email: row.email, hashedCode: row.hashedCode, expiresAt: row.expiresAt, wrongTries: row.wrongTries };
  },
});

/**
 * Check a typed code and, when it matches, attach the address — folding in
 * the account it belonged to if that account owns nothing. Everything is
 * re-checked here, in the transaction that writes, because the address's
 * standing may have changed since the code was mailed.
 */
export const consumeCode = internalMutation({
  args: { userId: v.id("users"), email: v.string(), hashedCode: v.string() },
  returns: v.union(
    v.literal("added"),
    v.literal("wrong"),
    v.literal("expired"),
    v.literal("has_own_workspace"),
  ),
  handler: async (ctx, { userId, email, hashedCode }) => {
    const row = await ctx.db
      .query("signInEmailCodes")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (row === null || row.email !== email) return "expired";
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

    const standing = await standingOf(ctx, userId, email);
    if (standing.kind === "mine") return "added";
    if (standing.kind === "blocked") return "has_own_workspace";
    if (standing.kind === "other") await foldIn(ctx, standing.otherId, userId);
    // Folding may already have brought this address over.
    if ((await standingOf(ctx, userId, email)).kind !== "mine") {
      await ctx.db.insert("signInEmails", { userId, email, addedAt: Date.now() });
    }
    return "added";
  },
});

/** Confirm the code mailed to the address being added. */
export const confirmAddEmail = action({
  args: { code: v.string() },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args): Promise<{ status: ConfirmStatus }> => {
    const userId = requireSignedIn((await getAuthUserId(ctx)) as Id<"users"> | null);
    const code = args.code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) return { status: "wrong" };
    const pending = await ctx.runQuery(internal.functions.signInEmails.codeFor, { userId });
    if (pending === null) return { status: "expired" };
    const status = await ctx.runMutation(internal.functions.signInEmails.consumeCode, {
      userId,
      email: pending.email,
      hashedCode: await hashToken(code),
    });
    return { status };
  },
});


// ── Changing ───────────────────────────────────────────────────────────────

/** Stop signing in with an extra address. The mail address cannot be removed. */
export const removeEmail = mutation({
  args: { email: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = requireSignedIn((await getAuthUserId(ctx)) as Id<"users"> | null);
    const email = args.email.trim().toLowerCase();
    const row = await ctx.db
      .query("signInEmails")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (row === null || row.userId !== userId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That email isn't on your account." });
    }
    await ctx.db.delete(row._id);
    await dropSignInsThrough(ctx, userId, email);
    return null;
  },
});

/** Send mail to a different one of this person's addresses. */
export const setMailEmail = mutation({
  args: { email: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = requireSignedIn((await getAuthUserId(ctx)) as Id<"users"> | null);
    const email = args.email.trim().toLowerCase();
    const row = await ctx.db
      .query("signInEmails")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (row === null || row.userId !== userId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That email isn't on your account." });
    }
    const user = await ctx.db.get(userId);
    if (user === null) throw new ConvexError({ code: "NOT_FOUND", message: "No account." });
    await ctx.db.delete(row._id);
    if (user.email !== undefined) {
      await ctx.db.insert("signInEmails", { userId, email: user.email.toLowerCase(), addedAt: Date.now() });
    }
    await ctx.db.patch(userId, { email, emailVerificationTime: user.emailVerificationTime ?? Date.now() });
    return null;
  },
});

/**
 * Remove the auth accounts an address signs in through, with their codes, so
 * a removed address stops signing in here. Sessions already open stay: they
 * belong to the account, not to the address used to start them.
 */
async function dropSignInsThrough(ctx: MutationCtx, userId: Id<"users">, email: string): Promise<void> {
  for (const provider of EMAIL_PROVIDERS) {
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) => q.eq("provider", provider).eq("providerAccountId", email))
      .take(5);
    for (const account of accounts) {
      if (account.userId !== userId) continue;
      const codes = await ctx.db
        .query("authVerificationCodes")
        .withIndex("accountId", (q) => q.eq("accountId", account._id))
        .take(20);
      for (const code of codes) await ctx.db.delete(code._id);
      await ctx.db.delete(account._id);
    }
  }
}
