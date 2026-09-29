/**
 * The waitlist's public door: the one email field on the homepage and /login.
 *
 * `enter` answers the question the field needs before anything else happens —
 * is this address let in? — and puts a stranger on the list in the same call.
 * Only an `admitted` answer is followed by `signIn("email")`, and the server
 * refuses that call for anybody else regardless (`lib/waitlist.ts`,
 * `apps/convex/auth.ts`). Nobody needs to be signed in to call anything here.
 *
 * Bounded twice, because a stranger drives it: one row and at most one
 * confirmation mail per address, ever, and a deployment-wide cap on new rows
 * per hour. A flood of junk addresses spends the cap and then gets a
 * `RATE_LIMITED` error; nobody already on the list is affected.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalQuery, mutation } from "../_generated/server";
import { consumeRateLimit } from "./lib/rateLimit";
import { isAdmitted, USE_FOR_MAX, waitlistEmail } from "./lib/waitlist";
import { renderWaitlistEmail } from "./lib/waitlistEmail";
import { validAppOrigin } from "./lib/invitationEmail";

/** New waitlist rows per window, across every caller. */
export const WAITLIST_JOINS_PER_HOUR = 300;
const WAITLIST_JOIN_WINDOW_MS = 60 * 60 * 1000;

const invalidEmail = () =>
  new ConvexError({ code: "INVALID_EMAIL", message: "Check the address and try again." });

export const enter = mutation({
  args: { email: v.string(), source: v.optional(v.union(v.literal("homepage"), v.literal("login"))) },
  returns: v.object({
    status: v.union(v.literal("admitted"), v.literal("joined"), v.literal("already")),
  }),
  handler: async (ctx, args) => {
    const email = waitlistEmail(args.email);
    if (email === null) throw invalidEmail();
    if (await isAdmitted(ctx.db, email)) return { status: "admitted" as const };

    const existing = await ctx.db
      .query("waitlist")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existing !== null) return { status: "already" as const };

    await consumeRateLimit(ctx, {
      key: "waitlist.join",
      limit: WAITLIST_JOINS_PER_HOUR,
      windowMs: WAITLIST_JOIN_WINDOW_MS,
    });
    const now = Date.now();
    const id = await ctx.db.insert("waitlist", {
      email,
      status: "waiting",
      joinedAt: now,
      source: args.source ?? "homepage",
      joinedMailAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.functions.waitlist.sendMail, { waitlistId: id, kind: "joined" });
    return { status: "joined" as const };
  },
});

/**
 * The optional "what would you use it for?" answer.
 *
 * Written once: a row that already has an answer keeps it, so somebody who
 * knows your address cannot rewrite what you said. Always returns `null`, so
 * it tells a caller nothing about the address either.
 */
export const describe = mutation({
  args: { email: v.string(), useFor: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const email = waitlistEmail(args.email);
    const useFor = args.useFor.trim().slice(0, USE_FOR_MAX);
    if (email === null || useFor.length === 0) return null;
    const row = await ctx.db
      .query("waitlist")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (row === null || row.status !== "waiting" || row.useFor !== undefined) return null;
    await ctx.db.patch(row._id, { useFor });
    return null;
  },
});

/** For `auth.ts`'s `canReceiveEmailCode`: the action ctx asks through this. */
export const admitted = internalQuery({
  args: { email: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => isAdmitted(ctx.db, args.email),
});

export const mailFacts = internalQuery({
  args: { waitlistId: v.id("waitlist") },
  returns: v.union(v.null(), v.object({ email: v.string() })),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.waitlistId);
    return row === null ? null : { email: row.email };
  },
});

/**
 * Send one waitlist message. The row's `joinedMailAt` / `admittedMailAt` was
 * claimed by whoever scheduled this, so it runs at most once per row and kind.
 * With no Resend key — tests, and self-hosters who have not set one up — it
 * does nothing, and says so without the address.
 */
export const sendMail = internalAction({
  args: { waitlistId: v.id("waitlist"), kind: v.union(v.literal("joined"), v.literal("admitted")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const log = (event: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ event: `waitlist_mail_${event}`, kind: args.kind, waitlistId: args.waitlistId, ...extra }));
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
    const facts = await ctx.runQuery(internal.functions.waitlist.mailFacts, { waitlistId: args.waitlistId });
    if (facts === null) return null;
    const rendered = renderWaitlistEmail(args.kind, new URL("/login", origin).toString());
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
      // The status only: Resend's error body quotes the address.
      log(response.ok ? "sent" : "failed", response.ok ? {} : { status: response.status });
    } catch {
      log("failed", { reason: "transport_error" });
    }
    return null;
  },
});
