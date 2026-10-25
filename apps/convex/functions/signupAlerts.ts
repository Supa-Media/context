/**
 * Signup alerts: a mail to staff for each new waitlist signup and each
 * brand-new account (Dev2, 2026-10-03).
 *
 * Opt-in per staff member, from the console's Waitlist tab, so a deployment
 * never mails anybody who did not ask — a self-hoster's included. With
 * `SIGNUP_ALERTS_EMAIL` set, the mail goes to that one team inbox instead of
 * to each subscriber (Dev2, 2026-10-25: context@supa.media in production);
 * the switch still decides whether alerts go out at all. Unset, the address is
 * each subscriber's own verified sign-in address, read when the mail goes out
 * and checked against `ADMIN_EMAILS` then, so taking somebody off staff also
 * takes them off this.
 *
 * Every alert goes out the moment it happens (Dev2, 2026-10-25: "make sure
 * the emails are immediate"). People sign up with a phone and pick their
 * handle a step later, so a new account is named by its phone, and a second
 * alert names the handle when it is picked in the app. Signing up by text
 * picks both at once, so that is one alert with the handle in it.
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
import { ownedPersonalWorkspace } from "./lib/accountSetup";
import { validAppOrigin } from "./lib/invitationEmail";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { renderSignupAlert, type SignupAlertFacts } from "./lib/signupAlertEmail";

export const SIGNUP_ALERTS_PER_HOUR = 60;
const SIGNUP_ALERT_WINDOW_MS = 60 * 60 * 1000;
/** Staff are a handful; this is a ceiling, not a page size. */
const MAX_SUBSCRIBERS = 50;
/** The one team inbox every alert goes to, when set. */
export const SIGNUP_ALERTS_EMAIL_ENV_VAR = "SIGNUP_ALERTS_EMAIL";

export function teamInbox(): string | null {
  const address = process.env[SIGNUP_ALERTS_EMAIL_ENV_VAR]?.trim().toLowerCase() ?? "";
  return address.includes("@") ? address : null;
}

const alertValidator = v.union(
  v.object({ kind: v.literal("waitlist"), waitlistId: v.id("waitlist") }),
  v.object({ kind: v.literal("account"), userId: v.id("users") }),
  v.object({ kind: v.literal("handle"), userId: v.id("users") }),
);
type Alert =
  | { kind: "waitlist"; waitlistId: Id<"waitlist"> }
  | { kind: "account" | "handle"; userId: Id<"users"> };

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
        v.object({
          kind: v.union(v.literal("account"), v.literal("handle")),
          handle: v.union(v.string(), v.null()),
          phone: v.union(v.string(), v.null()),
          email: v.union(v.string(), v.null()),
        }),
      ),
    }),
  ),
  handler: async (ctx, { alert }) => {
    let about: SignupAlertFacts;
    if (alert.kind === "waitlist") {
      const row = await ctx.db.get(alert.waitlistId);
      if (row === null) return null;
      // A row joined with a phone has its number where the address would be.
      about = { kind: "waitlist", email: row.email ?? row.phone ?? "", source: row.source, useFor: row.useFor ?? null };
    } else {
      const user = await ctx.db.get(alert.userId);
      if (user === null) return null;
      // The handle is the personal workspace's slug.
      const personal = await ownedPersonalWorkspace(ctx, alert.userId);
      if (alert.kind === "handle" && personal === null) return null;
      about = {
        kind: alert.kind,
        handle: personal?.slug ?? null,
        phone: typeof user.phone === "string" ? user.phone : null,
        email: typeof user.email === "string" ? user.email : null,
      };
    }
    const inbox = teamInbox();
    if (inbox !== null) return { recipients: [inbox], facts: about };
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
