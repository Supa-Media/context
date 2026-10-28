import { getAuthUserId } from "./lib/signedIn";
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, mutation, query } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "./lib/crypto";
import { appOrigin, sendAccountMail } from "./lib/accountMail";
import {
  cancelPendingRecoveries,
  confirmedEmailsOf,
  phoneSignInPaused,
  requireEmailProof,
  signOutSessions,
} from "./lib/emailProof";
import { TEXTS_CLIENT_ID } from "./textLinks";

/**
 * Every sign-in by phone is told to every email on the account (board k3),
 * with a "This wasn't me" link. The link signs every device out, pauses
 * phone sign-in, and stops the texting assistant answering the number, until
 * the person signs in by email and turns it back on with an emailed code.
 *
 * The mail says when and which number (its last four digits). It cannot say
 * where: the phone provider runs inside `@convex-dev/auth`, which hands us no
 * address or device, and a guessed one would be worse than none.
 */

/** How long a "This wasn't me" link works. */
export const ALERT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Queue the alert for a phone sign-in that just succeeded. Called from the
 * phone provider's transaction (`phoneSignIn.signInUser`), so an alert is
 * never sent for a sign-in that did not happen.
 */
export async function scheduleSignInAlert(ctx: MutationCtx, userId: Id<"users">, phone: string): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.functions.signInAlerts.sendAlert, {
    userId,
    phoneLast4: phone.slice(-4),
    at: Date.now(),
  });
}

export const storeAlert = internalMutation({
  args: { userId: v.id("users"), hashedToken: v.string(), phoneLast4: v.string(), at: v.number() },
  returns: v.array(v.string()),
  handler: async (ctx, { userId, hashedToken, phoneLast4, at }) => {
    const emails = await confirmedEmailsOf(ctx, userId);
    if (emails.length === 0) return [];
    await ctx.db.insert("signInAlerts", { userId, hashedToken, at, phoneLast4, expiresAt: at + ALERT_TTL_MS });
    return emails;
  },
});

export const sendAlert = internalAction({
  args: { userId: v.id("users"), phoneLast4: v.string(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, { userId, phoneLast4, at }) => {
    const token = newToken();
    const emails = await ctx.runMutation(internal.functions.signInAlerts.storeAlert, {
      userId,
      hashedToken: await hashToken(token),
      phoneLast4,
      at,
    });
    const when = new Date(at).toUTCString().replace(" GMT", " UTC");
    for (const email of emails) {
      await sendAccountMail("sign_in_alert", {
        to: email,
        subject: "New sign-in to your Context",
        text:
          `Someone signed in to your Context with your phone number, on ${when}, ` +
          `with a code texted to •••• ${phoneLast4}.\n\n` +
          `If this was you, there's nothing to do.\n\n` +
          `If it wasn't you, open this link and press "This wasn't me". It signs every device out, ` +
          `stops sign-in by phone and stops the assistant answering that number until you turn it back on:\n` +
          `${appOrigin()}/not-me?token=${token}\n\n` +
          `Big changes to your account still need a code sent to this email.`,
      });
    }
    return null;
  },
});

/**
 * "This wasn't me", from the alert's link. Needs no sign-in: the link is the
 * proof, and everything it does only takes access away. Single use. An action
 * because hashing the token is Web Crypto.
 */
export const reportNotMe = action({
  args: { token: v.string() },
  returns: v.object({ status: v.union(v.literal("done"), v.literal("expired")) }),
  handler: async (ctx, { token }): Promise<{ status: "done" | "expired" }> => {
    if (!/^[0-9a-f]{64}$/.test(token)) return { status: "expired" };
    const status = await ctx.runMutation(internal.functions.signInAlerts.useAlert, {
      hashedToken: await hashToken(token),
    });
    return { status };
  },
});

export const useAlert = internalMutation({
  args: { hashedToken: v.string() },
  returns: v.union(v.literal("done"), v.literal("expired")),
  handler: async (ctx, { hashedToken }) => {
    const alert = await ctx.db
      .query("signInAlerts")
      .withIndex("by_token", (q) => q.eq("hashedToken", hashedToken))
      .unique();
    if (alert === null || alert.usedAt !== undefined || alert.expiresAt <= Date.now()) return "expired";
    await ctx.db.patch(alert._id, { usedAt: Date.now() });
    await lockOutPhone(ctx, alert.userId);
    return "done";
  },
});

/** Whether phone sign-in is paused for the signed-in person. */
export const myPhonePause = query({
  args: {},
  returns: v.object({ paused: v.boolean() }),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { paused: false };
    return { paused: await phoneSignInPaused(ctx, userId) };
  },
});

/** Turn phone sign-in back on, after "This wasn't me". Needs an emailed code. */
export const resumePhoneSignIn = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
    await requireEmailProof(ctx, userId);
    const pauses = await ctx.db
      .query("phoneSignInPauses")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const pause of pauses) await ctx.db.delete(pause._id);
    return null;
  },
});

/** What "This wasn't me" does, once its link checks out. */
export async function lockOutPhone(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  if (!(await phoneSignInPaused(ctx, userId))) {
    await ctx.db.insert("phoneSignInPauses", { userId, pausedAt: Date.now() });
  }
  await signOutSessions(ctx, userId, null);
  // A new email the intruder started adding goes too: it would otherwise
  // attach itself a week after the person locked them out.
  await cancelPendingRecoveries(ctx, userId);
  // The texting assistant's live grant goes too; `applyTextsGrant` refuses a
  // new one while the pause stands.
  const grants = await ctx.db
    .query("oauthGrants")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const grant of grants) {
    if (grant.clientId === TEXTS_CLIENT_ID) await ctx.db.delete(grant._id);
  }
}

export const purgeExpiredAlerts = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const old = await ctx.db
      .query("signInAlerts")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now()))
      .take(200);
    for (const row of old) await ctx.db.delete(row._id);
    return null;
  },
});
