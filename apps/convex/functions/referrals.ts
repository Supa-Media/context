/**
 * Referrals and community links: the signed-in half.
 *
 * `mine` and `send`/`cancel`/`undoCancel` are the Invite friends dialog;
 * `preview` is the `/join/<token>` page a friend opens from the email;
 * `communityLinks` is every place that shows the Discord join link and the
 * other links staff keep in the console. The rules are `lib/referrals.ts`;
 * staff's half is in `functions/admin.ts`.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, mutation, query } from "../_generated/server";
import { handleForUser } from "./lib/identities";
import { validAppOrigin } from "./lib/invitationEmail";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import { hashToken } from "./lib/crypto";
import { consumeRateLimit } from "./lib/rateLimit";
import {
  accountFor,
  allowanceFor,
  INVITE_TTL_MS,
  invitesOff,
  invitesTo,
  SENDS_PER_DAY,
  sentBy,
  SITE_SENDS_PER_HOUR,
  UNDO_WINDOW_MS,
} from "./lib/referrals";
import { renderReferralEmail, shortDate } from "./lib/referralEmail";
import { isAdmittedWithoutReferral, waitlistEmail } from "./lib/waitlist";

/** One person's daily send cap, and the whole deployment's hourly one. */
const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;
const SITE_SEND_WINDOW_MS = 60 * 60 * 1000;

const inviteStatusValidator = v.union(
  v.literal("pending"),
  v.literal("joined"),
  v.literal("expired"),
  v.literal("cancelled"),
  v.literal("revoked"),
);

const refuse = (code: string, message: string) => new ConvexError({ code, message });

async function viewer(ctx: Parameters<typeof getAuthUserId>[0]): Promise<Id<"users">> {
  const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
  if (userId === null) throw refuse("UNAUTHENTICATED", "Sign in first.");
  return userId;
}

/** The Invite friends dialog: how many are left, and what happened to each. */
export const mine = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      off: v.boolean(),
      locked: v.union(v.null(), v.literal("setup"), v.literal("new")),
      unlocksAt: v.union(v.null(), v.number()),
      total: v.number(),
      left: v.number(),
      invites: v.array(
        v.object({
          id: v.id("referralInvites"),
          email: v.string(),
          status: inviteStatusValidator,
          sentAt: v.number(),
          expiresAt: v.number(),
          cancelledAt: v.union(v.null(), v.number()),
          joinedHandle: v.union(v.null(), v.string()),
        }),
      ),
    }),
  ),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    const now = Date.now();
    const allowance = await allowanceFor(ctx.db, userId, now);
    const rows = await sentBy(ctx.db, userId, now);
    const invites = [];
    for (const row of rows) {
      invites.push({
        id: row.invite._id,
        email: row.invite.email,
        status: row.status,
        sentAt: row.invite.createdAt,
        expiresAt: row.invite.expiresAt,
        cancelledAt: row.invite.cancelledAt ?? null,
        joinedHandle: row.joinedUserId === null ? null : await handleForUser(ctx, row.joinedUserId),
      });
    }
    return {
      off: await invitesOff(ctx.db),
      locked: allowance.locked,
      unlocksAt: allowance.unlocksAt,
      total: allowance.total,
      left: allowance.left,
      invites,
    };
  },
});

/**
 * Invite one address.
 *
 * `already` means the address is let in without an invite, and nothing was
 * used — the waitlist field tells anybody the same. An address only somebody
 * *else's* invite admits is sent to like any other, so this never reveals who
 * else invited whom. Sending twice to the same address returns the first
 * invite and mails nobody again.
 */
export const send = mutation({
  args: { email: v.string() },
  returns: v.object({ status: v.union(v.literal("sent"), v.literal("already")) }),
  handler: async (ctx, args) => {
    const userId = await viewer(ctx);
    const email = waitlistEmail(args.email);
    if (email === null) throw refuse("INVALID_EMAIL", "Check the address and try again.");
    if (await invitesOff(ctx.db)) throw refuse("INVITES_OFF", "Invites are paused right now.");
    const now = Date.now();

    if (await isAdmittedWithoutReferral(ctx.db, email, process.env, now)) return { status: "already" as const };

    const { invites, statuses } = await invitesTo(ctx.db, email, now);
    const mineLive = invites.find(
      (invite) => invite.inviterUserId === userId && statuses.get(invite._id) === "pending",
    );
    if (mineLive !== undefined) return { status: "sent" as const };

    const allowance = await allowanceFor(ctx.db, userId, now);
    if (allowance.locked !== null) throw refuse("LOCKED", "Finish setting up first.");
    if (allowance.left <= 0) throw refuse("LIMIT_REACHED", "You've used all your invites.");

    await consumeRateLimit(ctx, { key: `referral.send:${userId}`, limit: SENDS_PER_DAY, windowMs: SEND_WINDOW_MS });
    await consumeRateLimit(ctx, { key: "referral.send", limit: SITE_SENDS_PER_HOUR, windowMs: SITE_SEND_WINDOW_MS });

    const id = await ctx.db.insert("referralInvites", {
      inviterUserId: userId,
      email,
      token: randomOpaqueToken(24),
      status: "pending",
      createdAt: now,
      expiresAt: now + INVITE_TTL_MS,
    });
    await ctx.scheduler.runAfter(0, internal.functions.referrals.sendMail, { inviteId: id });
    console.log(JSON.stringify({ event: "referral_sent", inviteId: id, by: userId }));
    return { status: "sent" as const };
  },
});

/** Take back an invite that has not been used. It is returned to the sender. */
export const cancel = mutation({
  args: { inviteId: v.id("referralInvites") },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await viewer(ctx);
    const invite = await ctx.db.get(args.inviteId);
    // Somebody else's invite reads exactly like a missing one.
    if (invite === null || invite.inviterUserId !== userId) return { changed: false };
    const { statuses } = await invitesTo(ctx.db, invite.email, Date.now());
    if (statuses.get(invite._id) !== "pending") return { changed: false };
    await ctx.db.patch(invite._id, { status: "cancelled", cancelledAt: Date.now() });
    console.log(JSON.stringify({ event: "referral_cancelled", inviteId: invite._id, by: userId }));
    return { changed: true };
  },
});

/**
 * Undo a cancel, shortly after it. The invite comes back as it was — same
 * link, same expiry — and nobody is mailed again.
 */
export const undoCancel = mutation({
  args: { inviteId: v.id("referralInvites") },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await viewer(ctx);
    const invite = await ctx.db.get(args.inviteId);
    if (invite === null || invite.inviterUserId !== userId || invite.status !== "cancelled") {
      return { changed: false };
    }
    const now = Date.now();
    if (invite.cancelledAt === undefined || now - invite.cancelledAt > UNDO_WINDOW_MS) return { changed: false };
    if (invite.expiresAt <= now) return { changed: false };
    // Joined meanwhile, through somebody else's invite or any other way: an
    // invite brought back now would take credit for a join it had no part in.
    if ((await accountFor(ctx.db, invite.email)) !== null) return { changed: false };
    const allowance = await allowanceFor(ctx.db, userId, now);
    if (allowance.left <= 0) return { changed: false };
    await ctx.db.patch(invite._id, { status: "pending", cancelledAt: undefined });
    return { changed: true };
  },
});

/**
 * The `/join/<token>` page: who invited you, and whether the invite still
 * works. Never the address. An unknown token and a dead one read the same, so
 * revoking is never announced.
 */
export const preview = query({
  args: { token: v.string() },
  returns: v.object({ works: v.boolean(), inviterHandle: v.union(v.null(), v.string()) }),
  handler: async (ctx, args) => {
    const invite =
      args.token.length === 0 || args.token.length > 100
        ? null
        : await ctx.db
            .query("referralInvites")
            .withIndex("by_token", (q) => q.eq("token", args.token))
            .unique();
    if (invite === null) return { works: false, inviterHandle: null };
    const { statuses } = await invitesTo(ctx.db, invite.email, Date.now());
    const works = statuses.get(invite._id) === "pending";
    return { works, inviterHandle: works ? await handleForUser(ctx, invite.inviterUserId) : null };
  },
});

/**
 * Links to the community and elsewhere, as staff keep them in the console.
 * `members` links (the private Discord invite) go only to somebody signed in.
 */
export const communityLinks = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("communityLinks"),
      kind: v.string(),
      label: v.string(),
      url: v.string(),
      audience: v.union(v.literal("members"), v.literal("everyone")),
    }),
  ),
  handler: async (ctx) => {
    const signedIn = (await getAuthUserId(ctx)) !== null;
    const rows = await ctx.db.query("communityLinks").withIndex("by_position").take(50);
    return rows
      .filter((row) => signedIn || row.audience === "everyone")
      .map((row) => ({ id: row._id, kind: row.kind, label: row.label, url: row.url, audience: row.audience }));
  },
});

/**
 * Mails one address may be sent by referrals in a day, whoever sends them.
 *
 * Each inviter can mail an address only once per live invite, but cancelling
 * and sending again, or several accounts inviting the same person, would each
 * mail again. Keyed on the recipient, and spent here in the scheduled claim
 * rather than in `send`, so a refusal is never an error the inviter sees:
 * that would tell them how much mail *other* people had sent the address.
 * The same design as workspace invitation mail (`invitationEmail.ts`).
 */
const RECIPIENT_MAIL_LIMIT = 3;
const RECIPIENT_MAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Claim one invite's email: at most once per invite, and only while it is
 * still live. Returns what the message needs, or null for every reason not to
 * send, all alike.
 */
export const claimMail = internalMutation({
  args: { inviteId: v.id("referralInvites") },
  returns: v.union(
    v.null(),
    v.object({ email: v.string(), token: v.string(), expiresAt: v.number(), inviterHandle: v.union(v.null(), v.string()) }),
  ),
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId);
    if (invite === null || invite.mailedAt !== undefined) return null;
    const { statuses } = await invitesTo(ctx.db, invite.email, Date.now());
    if (statuses.get(invite._id) !== "pending") return null;
    // Hashed: the limiter table has no need of a second list of addresses.
    try {
      await consumeRateLimit(ctx, {
        key: `referral.mail:${await hashToken(invite.email)}`,
        limit: RECIPIENT_MAIL_LIMIT,
        windowMs: RECIPIENT_MAIL_WINDOW_MS,
      });
    } catch {
      return null;
    }
    await ctx.db.patch(invite._id, { mailedAt: Date.now() });
    return {
      email: invite.email,
      token: invite.token,
      expiresAt: invite.expiresAt,
      inviterHandle: await handleForUser(ctx, invite.inviterUserId),
    };
  },
});

/**
 * Send one invite's mail. Scheduled once, by the insert in `send`, so each
 * invite is mailed at most once. With no Resend key it does nothing and says
 * so, without the address.
 */
export const sendMail = internalAction({
  args: { inviteId: v.id("referralInvites") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const log = (event: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ event: `referral_mail_${event}`, inviteId: args.inviteId, ...extra }));
    const apiKey = process.env.RESEND_API_KEY;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      log("skipped", { reason: "resend_unconfigured" });
      return null;
    }
    const origin = validAppOrigin();
    if (origin === null) {
      log("skipped", { reason: "app_origin_unset" });
      return null;
    }
    const facts = await ctx.runMutation(internal.functions.referrals.claimMail, { inviteId: args.inviteId });
    if (facts === null) {
      log("skipped", { reason: "not_sendable" });
      return null;
    }
    const rendered = renderReferralEmail(
      facts.inviterHandle,
      new URL(`/join/${facts.token}`, origin).toString(),
      shortDate(facts.expiresAt),
    );
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.AUTH_EMAIL_FROM ?? "hello@context.lc",
          to: facts.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        }),
      });
      log(response.ok ? "sent" : "failed", response.ok ? {} : { status: response.status });
    } catch {
      log("failed", { reason: "transport_error" });
    }
    return null;
  },
});
