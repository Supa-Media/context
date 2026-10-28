import { getAuthUserId } from "./lib/signedIn";
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "./lib/crypto";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { parseInvitee } from "./lib/invitees";
import { accountsForEmail, attachedEmailsOf, MAX_EMAILS_PER_ACCOUNT } from "./lib/signInEmails";
import { appOrigin, sendAccountMail } from "./lib/accountMail";
import { confirmedEmailsOf, maskEmail, requireEmailProof } from "./lib/emailProof";

/**
 * Lost every email (board k4).
 *
 * A person signed in with only their phone cannot confirm a big change, and
 * cannot add an email either, because adding one is itself a big change. So a
 * new address may still be added without the old ones, but only slowly: it
 * waits seven days, every current email is told at once and again a day
 * before, and any of them can cancel it with one click. A thief holding only
 * the phone has to sit through a week of warnings sent to the real owner.
 *
 * Nobody can shorten the wait, staff included: there is no function for it.
 */

export const RECOVERY_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
/** The second notice goes out this long before the wait ends ("day 6"). */
export const REMINDER_BEFORE_MS = 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_WRONG_TRIES = 5;
const SEND_LIMIT = 3;
const WINDOW_MS = 60 * 60 * 1000;

type StartStatus = "sent" | "invalid_email" | "taken" | "waiting" | "too_many_emails" | "too_many" | "not_needed";

function requireSignedIn(userId: Id<"users"> | null): Id<"users"> {
  if (userId === null) throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  return userId;
}

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(bytes[0] % 10 ** 6).padStart(6, "0");
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function waitingRecoveryOf(ctx: MutationCtx | Parameters<typeof confirmedEmailsOf>[0], userId: Id<"users">) {
  const rows = await ctx.db
    .query("emailRecoveries")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return rows.find((row) => row.status === "waiting") ?? null;
}

/** The new email waiting out its seven days, if any. */
export const myEmailRecovery = query({
  args: {},
  returns: v.union(v.null(), v.object({ email: v.string(), finishesAt: v.number() })),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const waiting = await waitingRecoveryOf(ctx, userId);
    return waiting === null ? null : { email: waiting.email, finishesAt: waiting.finishesAt };
  },
});

export const prepareCode = internalMutation({
  args: { userId: v.id("users"), email: v.string(), hashedCode: v.string() },
  returns: v.string(),
  handler: async (ctx, { userId, email, hashedCode }): Promise<Exclude<StartStatus, "sent" | "invalid_email"> | "ok"> => {
    // An account with no email yet adds its first one the ordinary way.
    if ((await confirmedEmailsOf(ctx, userId)).length === 0) return "not_needed";
    if ((await waitingRecoveryOf(ctx, userId)) !== null) return "waiting";
    if ((await accountsForEmail(ctx, email, { verifiedOnly: false })).length > 0) return "taken";
    if ((await attachedEmailsOf(ctx, userId)).length >= MAX_EMAILS_PER_ACCOUNT) return "too_many_emails";
    if (!(await tryConsumeRateLimit(ctx, { key: `emailRecovery.send:${userId}`, limit: SEND_LIMIT, windowMs: WINDOW_MS }))) {
      return "too_many";
    }
    const old = await ctx.db
      .query("emailRecoveryCodes")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(10);
    for (const row of old) await ctx.db.delete(row._id);
    await ctx.db.insert("emailRecoveryCodes", {
      userId,
      email,
      hashedCode,
      expiresAt: Date.now() + CODE_TTL_MS,
      wrongTries: 0,
    });
    return "ok";
  },
});

/** Mail a code to the new address, to prove it is the person's before the wait starts. */
export const startEmailRecovery = action({
  args: { email: v.string() },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args): Promise<{ status: StartStatus }> => {
    const userId = requireSignedIn((await getAuthUserId(ctx)) as Id<"users"> | null);
    const parsed = parseInvitee(args.email);
    if (!parsed.ok || parsed.invitee.kind !== "email") return { status: "invalid_email" };
    const email = parsed.invitee.value;
    const code = newCode();
    const prepared = (await ctx.runMutation(internal.functions.emailRecovery.prepareCode, {
      userId,
      email,
      hashedCode: await hashToken(code),
    })) as Exclude<StartStatus, "sent" | "invalid_email"> | "ok";
    if (prepared !== "ok") return { status: prepared };
    await ctx.scheduler.runAfter(0, internal.functions.emailRecovery.mail, {
      to: email,
      subject: `${code} is your Context code`,
      text:
        `${code} is your code to add this email to your Context account.\n\n` +
        `After you type it, the email is added in seven days, and your current emails are told so they can stop it. ` +
        `If you didn't ask for this, ignore this email.`,
    });
    return { status: "sent" };
  },
});

export const consumeCode = internalMutation({
  args: { userId: v.id("users"), hashedCode: v.string(), hashedCancelToken: v.string() },
  returns: v.union(
    v.object({ status: v.literal("started"), email: v.string(), finishesAt: v.number(), notify: v.array(v.string()) }),
    v.object({ status: v.union(v.literal("wrong"), v.literal("expired"), v.literal("taken"), v.literal("waiting")) }),
  ),
  handler: async (ctx, { userId, hashedCode, hashedCancelToken }) => {
    const row = await ctx.db
      .query("emailRecoveryCodes")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (row === null) return { status: "expired" as const };
    if (row.expiresAt <= Date.now()) {
      await ctx.db.delete(row._id);
      return { status: "expired" as const };
    }
    if (row.hashedCode !== hashedCode) {
      if (row.wrongTries + 1 >= MAX_WRONG_TRIES) await ctx.db.delete(row._id);
      else await ctx.db.patch(row._id, { wrongTries: row.wrongTries + 1 });
      return { status: "wrong" as const };
    }
    await ctx.db.delete(row._id);
    if ((await waitingRecoveryOf(ctx, userId)) !== null) return { status: "waiting" as const };
    if ((await accountsForEmail(ctx, row.email, { verifiedOnly: false })).length > 0) return { status: "taken" as const };
    const now = Date.now();
    const finishesAt = now + RECOVERY_WAIT_MS;
    await ctx.db.insert("emailRecoveries", {
      userId,
      email: row.email,
      startedAt: now,
      finishesAt,
      hashedCancelToken,
      status: "waiting",
    });
    return { status: "started" as const, email: row.email, finishesAt, notify: await confirmedEmailsOf(ctx, userId) };
  },
});

/** Type back the code; the seven days start and every current email is told. */
export const confirmEmailRecovery = action({
  args: { code: v.string() },
  returns: v.object({ status: v.string(), finishesAt: v.optional(v.number()) }),
  handler: async (ctx, args): Promise<{ status: string; finishesAt?: number }> => {
    const userId = requireSignedIn((await getAuthUserId(ctx)) as Id<"users"> | null);
    const code = args.code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) return { status: "wrong" };
    const cancelToken = newToken();
    const result = await ctx.runMutation(internal.functions.emailRecovery.consumeCode, {
      userId,
      hashedCode: await hashToken(code),
      hashedCancelToken: await hashToken(cancelToken),
    });
    if (result.status !== "started") return { status: result.status };
    await ctx.scheduler.runAfter(0, internal.functions.emailRecovery.notifyCurrentEmails, {
      to: result.notify,
      newEmail: maskEmail(result.email),
      finishesAt: result.finishesAt,
      cancelToken,
      reminder: false,
    });
    return { status: "started", finishesAt: result.finishesAt };
  },
});

function noticeText(newEmail: string, finishesAt: number, cancelToken: string, reminder: boolean): string {
  const when = new Date(finishesAt).toUTCString().replace(" GMT", " UTC");
  return (
    (reminder ? `Reminder: ` : ``) +
    `someone signed in to your Context with your phone number and asked to add a new email, ${newEmail}, ` +
    `because they say they can't get into any of the emails on the account.\n\n` +
    `It will be added on ${when}. After that it can confirm big changes, like changing the phone number or ` +
    `moving your notes.\n\n` +
    `If this isn't you, stop it now:\n${appOrigin()}/stop-new-email?token=${cancelToken}\n\n` +
    `Then sign in with this email and sign out the devices you don't know. Your phone number may have been ` +
    `moved to someone else's SIM: call your carrier.`
  );
}

/**
 * Tell the current emails. The cancel link is the only copy of its token, so
 * the reminder mails the same link: the action holds the token only in the
 * scheduler's arguments, never in a table.
 */
export const notifyCurrentEmails = internalAction({
  args: {
    to: v.array(v.string()),
    newEmail: v.string(),
    finishesAt: v.number(),
    cancelToken: v.string(),
    reminder: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const to of args.to) {
      await sendAccountMail(args.reminder ? "email_recovery_reminder" : "email_recovery_notice", {
        to,
        subject: args.reminder ? "Reminder: a new email is being added to your Context" : "A new email is being added to your Context",
        text: noticeText(args.newEmail, args.finishesAt, args.cancelToken, args.reminder),
      });
    }
    if (!args.reminder) {
      // The day-6 reminder carries the same link, so it is scheduled now,
      // while the token still exists somewhere.
      await ctx.scheduler.runAt(args.finishesAt - REMINDER_BEFORE_MS, internal.functions.emailRecovery.remind, {
        hashedCancelToken: await hashToken(args.cancelToken),
        cancelToken: args.cancelToken,
      });
    }
    return null;
  },
});

export const reminderTargets = internalQuery({
  args: { hashedCancelToken: v.string() },
  returns: v.union(v.null(), v.object({ to: v.array(v.string()), email: v.string(), finishesAt: v.number() })),
  handler: async (ctx, { hashedCancelToken }) => {
    const row = await ctx.db
      .query("emailRecoveries")
      .withIndex("by_cancel_token", (q) => q.eq("hashedCancelToken", hashedCancelToken))
      .unique();
    if (row === null || row.status !== "waiting") return null;
    return { to: await confirmedEmailsOf(ctx, row.userId), email: row.email, finishesAt: row.finishesAt };
  },
});

export const remind = internalAction({
  args: { hashedCancelToken: v.string(), cancelToken: v.string() },
  returns: v.null(),
  handler: async (ctx, { hashedCancelToken, cancelToken }) => {
    const target = await ctx.runQuery(internal.functions.emailRecovery.reminderTargets, { hashedCancelToken });
    if (target === null) return null;
    await ctx.runAction(internal.functions.emailRecovery.notifyCurrentEmails, {
      to: target.to,
      newEmail: maskEmail(target.email),
      finishesAt: target.finishesAt,
      cancelToken,
      reminder: true,
    });
    return null;
  },
});

export const mail = internalAction({
  args: { to: v.string(), subject: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (_ctx, args) => {
    await sendAccountMail("email_recovery_code", args);
    return null;
  },
});

/** "Stop it", from the notice. Needs no sign-in: it only takes something away. */
export const cancelByLink = action({
  args: { token: v.string() },
  returns: v.object({ status: v.union(v.literal("cancelled"), v.literal("expired")) }),
  handler: async (ctx, { token }): Promise<{ status: "cancelled" | "expired" }> => {
    if (!/^[0-9a-f]{64}$/.test(token)) return { status: "expired" };
    const status = await ctx.runMutation(internal.functions.emailRecovery.cancelByHash, {
      hashedCancelToken: await hashToken(token),
    });
    return { status };
  },
});

export const cancelByHash = internalMutation({
  args: { hashedCancelToken: v.string() },
  returns: v.union(v.literal("cancelled"), v.literal("expired")),
  handler: async (ctx, { hashedCancelToken }) => {
    const row = await ctx.db
      .query("emailRecoveries")
      .withIndex("by_cancel_token", (q) => q.eq("hashedCancelToken", hashedCancelToken))
      .unique();
    if (row === null || row.status !== "waiting") return "expired";
    await ctx.db.patch(row._id, { status: "cancelled" });
    return "cancelled";
  },
});

/**
 * Stop it from the app. Whoever started it can stop it; anybody else signed
 * in to the account needs an emailed code first, the same as any big change.
 */
export const cancelMine = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = requireSignedIn(await getAuthUserId(ctx));
    const waiting = await waitingRecoveryOf(ctx, userId);
    if (waiting === null) return null;
    await requireEmailProof(ctx, userId);
    await ctx.db.patch(waiting._id, { status: "cancelled" });
    return null;
  },
});

/** Hourly: add the addresses whose seven days are up. */
export const finishDue = internalMutation({
  args: {},
  returns: v.object({ finished: v.number() }),
  handler: async (ctx) => {
    const due = await ctx.db
      .query("emailRecoveries")
      .withIndex("by_status_finishesAt", (q) => q.eq("status", "waiting").lte("finishesAt", Date.now()))
      .take(50);
    let finished = 0;
    for (const row of due) {
      // Re-checked: the address may have gone to another account meanwhile,
      // or the account may be gone.
      const user = await ctx.db.get(row.userId);
      const holders = await accountsForEmail(ctx, row.email, { verifiedOnly: false });
      if (user === null || holders.length > 0) {
        await ctx.db.patch(row._id, { status: "cancelled" });
        continue;
      }
      await ctx.db.insert("signInEmails", { userId: row.userId, email: row.email, addedAt: Date.now() });
      await ctx.db.patch(row._id, { status: "done" });
      finished += 1;
    }
    return { finished };
  },
});
