import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, mutation, query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "./lib/crypto";
import { foldIn, ownsAnything } from "./lib/account/foldIn";
import { accountsForEmail, attachedEmailsOf, MAX_EMAILS_PER_ACCOUNT } from "./lib/signInEmails";

/**
 * "Do you already use Context with another email?" (Dev2, 2026-10-09, board
 * s7). Somebody's boss shares a note with their work address; they sign in
 * with it and get a brand-new account, though they already use Context with
 * another address. Asked once, right after that first sign-in.
 *
 * "Yes" is three steps, and the only new trust in them is a hand-off token:
 *
 *  1. The new account mints a token (`startHandOff`). It owns nothing yet, or
 *     the question is not asked. Only the token's hash is stored.
 *  2. The app signs in with the other address the ordinary way, with the code
 *     mailed to it. That is the proof of the other mailbox; nothing here
 *     replaces it.
 *  3. Signed in as that account, the app spends the token (`finishHandOff`):
 *     the new account is folded in exactly as option C folds one in from
 *     Account settings — memberships move, the address becomes one this
 *     person signs in with, the empty account closes.
 *
 * The token is the proof of the first mailbox: only a session that signed in
 * with it can mint one. "No" is answered once on the account and never asked
 * again; Account settings can still add the address later.
 */

export const HAND_OFF_TTL_MS = 15 * 60 * 1000;
/** The in-app message this question is answered under (`packages/shared`). */
const QUESTION = "other-email";

type FinishStatus = "added" | "expired" | "same_account" | "has_own_workspace" | "too_many_emails";

function requireSignedIn(userId: Id<"users"> | null): Id<"users"> {
  if (userId === null) throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  return userId;
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether this account is one the question is for: signed in by email, owning nothing. */
async function couldHandOff(ctx: QueryCtx, userId: Id<"users">): Promise<string | null> {
  const me = await ctx.db.get(userId);
  if (me?.email === undefined || me.emailVerificationTime === undefined) return null;
  if (await ownsAnything(ctx, userId)) return null;
  return me.email;
}

/** Whether to ask, and the address that just signed in. */
export const myOtherEmailQuestion = query({
  args: {},
  returns: v.object({ ask: v.boolean(), email: v.union(v.string(), v.null()) }),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return { ask: false, email: null };
    const email = await couldHandOff(ctx, userId);
    if (email === null) return { ask: false, email: null };
    const answered = await ctx.db
      .query("messageReads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("message"), QUESTION))
      .first();
    return { ask: answered === null, email };
  },
});

export const recordHandOff = internalMutation({
  args: { userId: v.id("users"), hashedToken: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if ((await couldHandOff(ctx, args.userId)) === null) return false;
    const earlier = await ctx.db
      .query("emailHandOffs")
      .withIndex("by_user", (q) => q.eq("fromUserId", args.userId))
      .collect();
    for (const row of earlier) await ctx.db.delete(row._id);
    await ctx.db.insert("emailHandOffs", {
      fromUserId: args.userId,
      hashedToken: args.hashedToken,
      expiresAt: Date.now() + HAND_OFF_TTL_MS,
    });
    return true;
  },
});

/** Step 1: the new account says "yes" and gets a token to carry across. */
export const startHandOff = action({
  args: {},
  returns: v.object({ status: v.string(), token: v.optional(v.string()) }),
  handler: async (ctx): Promise<{ status: "ok" | "not_needed"; token?: string }> => {
    const userId = requireSignedIn((await getAuthUserId(ctx)) as Id<"users"> | null);
    const token = newToken();
    const recorded: boolean = await ctx.runMutation(internal.functions.otherEmail.recordHandOff, {
      userId,
      hashedToken: await hashToken(token),
    });
    return recorded ? { status: "ok", token } : { status: "not_needed" };
  },
});

/**
 * Step 3: signed in with the other address, take the new one over. Every
 * check is made again here, in the transaction that folds: the new account
 * may have come to own something since the token was minted.
 */
export const finishHandOff = mutation({
  args: { token: v.string() },
  returns: v.object({ status: v.string(), email: v.optional(v.string()) }),
  handler: async (ctx, args): Promise<{ status: FinishStatus; email?: string }> => {
    const intoId = requireSignedIn((await getAuthUserId(ctx)) as Id<"users"> | null);
    const hashedToken = await hashToken(args.token);
    const row = await ctx.db
      .query("emailHandOffs")
      .withIndex("by_token", (q) => q.eq("hashedToken", hashedToken))
      .unique();
    if (row === null) return { status: "expired" };
    if (row.expiresAt <= Date.now()) {
      await ctx.db.delete(row._id);
      return { status: "expired" };
    }
    const fromId = row.fromUserId;
    // Signing in with the same address again lands in the same account.
    if (fromId === intoId) return { status: "same_account" };
    await ctx.db.delete(row._id);

    const email = await couldHandOff(ctx, fromId);
    if (email === null) return { status: "has_own_workspace" };
    // The address must be the new account's alone, as the add flow requires.
    const holders = await accountsForEmail(ctx, email, { verifiedOnly: false });
    if (holders.some((holder) => holder !== fromId)) return { status: "has_own_workspace" };
    const mine = await ctx.db.get(intoId);
    const count = (mine?.email === undefined ? 0 : 1) + (await attachedEmailsOf(ctx, intoId)).length;
    if (count >= MAX_EMAILS_PER_ACCOUNT) return { status: "too_many_emails" };

    await foldIn(ctx, fromId, intoId);
    return { status: "added", email: email.toLowerCase() };
  },
});
