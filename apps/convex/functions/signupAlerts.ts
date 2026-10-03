/**
 * Signup alerts: a mail to staff for each new waitlist signup and each
 * brand-new account (Dev2, 2026-10-03).
 *
 * Opt-in per staff member, from the console's Waitlist tab, so a deployment
 * never mails anybody who did not ask — a self-hoster's included. The address
 * is the subscriber's own verified sign-in address, read when the mail goes
 * out and checked against `ADMIN_EMAILS` then, so taking somebody off staff
 * also takes them off this.
 *
 * Bounded, because a stranger can trigger the waitlist half: at most
 * `SIGNUP_ALERTS_PER_HOUR` alerts across the deployment. Past that the signup
 * still lands and is in the console; only the mail is skipped.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type MutationCtx } from "../_generated/server";
import { isAdminEmail } from "./lib/admin";
import { validAppOrigin } from "./lib/invitationEmail";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { renderSignupAlert, type SignupAlertFacts } from "./lib/signupAlertEmail";

export const SIGNUP_ALERTS_PER_HOUR = 60;
const SIGNUP_ALERT_WINDOW_MS = 60 * 60 * 1000;
/** Staff are a handful; this is a ceiling, not a page size. */
const MAX_SUBSCRIBERS = 50;

const alertValidator = v.union(
  v.object({ kind: v.literal("waitlist"), waitlistId: v.id("waitlist") }),
  v.object({ kind: v.literal("account"), userId: v.id("users") }),
);
type Alert = { kind: "waitlist"; waitlistId: Id<"waitlist"> } | { kind: "account"; userId: Id<"users"> };

/**
 * Queue one alert, from inside the mutation that made the signup, so it is
 * sent only if the signup commits. Nobody subscribed means nothing scheduled
 * and nothing spent from the hourly allowance.
 */
export async function scheduleSignupAlert(ctx: MutationCtx, alert: Alert): Promise<void> {
  const anyone = await ctx.db.query("signupAlertSubscribers").first();
  if (anyone === null) return;
  const room = await tryConsumeRateLimit(ctx, {
    key: "signupAlerts",
    limit: SIGNUP_ALERTS_PER_HOUR,
    windowMs: SIGNUP_ALERT_WINDOW_MS,
  });
  if (!room) {
    console.log(JSON.stringify({ event: "signup_alert_skipped", kind: alert.kind, reason: "rate_limited" }));
    return;
  }
  await ctx.scheduler.runAfter(0, internal.functions.signupAlerts.send, { alert });
}

/** Who to mail, and what about. `null` when the row has gone since. */
export const facts = internalQuery({
  args: { alert: alertValidator },
  returns: v.union(
    v.null(),
    v.object({
      recipients: v.array(v.string()),
      facts: v.union(
        v.object({ kind: v.literal("waitlist"), email: v.string(), source: v.string(), useFor: v.union(v.string(), v.null()) }),
        v.object({ kind: v.literal("account"), email: v.union(v.string(), v.null()) }),
      ),
    }),
  ),
  handler: async (ctx, { alert }) => {
    let about: SignupAlertFacts;
    if (alert.kind === "waitlist") {
      const row = await ctx.db.get(alert.waitlistId);
      if (row === null) return null;
      about = { kind: "waitlist", email: row.email, source: row.source, useFor: row.useFor ?? null };
    } else {
      const user = await ctx.db.get(alert.userId);
      if (user === null) return null;
      about = { kind: "account", email: typeof user.email === "string" ? user.email : null };
    }
    const recipients = new Set<string>();
    for (const sub of await ctx.db.query("signupAlertSubscribers").take(MAX_SUBSCRIBERS)) {
      const user = await ctx.db.get(sub.userId);
      // Verified, and still staff: the same two things `requireAdmin` asks.
      if (user === null || user.emailVerificationTime === undefined) continue;
      if (typeof user.email !== "string" || !isAdminEmail(user.email)) continue;
      recipients.add(user.email.trim().toLowerCase());
    }
    return { recipients: [...recipients], facts: about };
  },
});

/**
 * Mail the alert, one message per staff member so nobody sees who else is
 * subscribed. With no Resend key it does nothing, and says so without any
 * address.
 */
export const send = internalAction({
  args: { alert: alertValidator },
  returns: v.null(),
  handler: async (ctx, { alert }) => {
    const log = (event: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ event: `signup_alert_${event}`, kind: alert.kind, ...extra }));
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
    const found = await ctx.runQuery(internal.functions.signupAlerts.facts, { alert });
    if (found === null || found.recipients.length === 0) return null;
    const rendered = renderSignupAlert(found.facts, new URL("/admin", origin).toString());
    for (const to of found.recipients) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: process.env.AUTH_EMAIL_FROM ?? "hello@context.lc",
            to,
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
    }
    return null;
  },
});
