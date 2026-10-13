/**
 * The "You're in" text, for somebody who joined the waitlist with a phone
 * (Dev2, 2026-10-12: "How do they know that they've gotten off the
 * waitlist?"). The email rows get the "You're in" mail; a phone row has no
 * address, so it gets this instead.
 *
 * Only staff letting a row in schedules it (`lib/adminFns/waitlist.ts`
 * `admitRow`), after claiming the row's `admittedTextAt` in the same
 * transaction, so each row is texted at most once and nobody outside can make
 * Context text a number. Joining the list still texts nothing.
 *
 * It goes through the same Messaging Service as sign-in codes. Twilio Verify
 * can only send codes, so with no Messaging Service set the text is skipped
 * and the log says why; the number never appears in the log.
 */

import { sendTwilioSms } from "@supa-media/convex/auth";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalQuery } from "../_generated/server";
import { validAppOrigin } from "./lib/invitationEmail";
import { smsKeys } from "./phoneCodes";

/** What the text says; `signInUrl` is the deployment's /login. */
export function admittedText(signInUrl: string): string {
  return `You're in! Context is ready for you. Sign in with this phone number at ${signInUrl}`;
}

export const textFacts = internalQuery({
  args: { waitlistId: v.id("waitlist") },
  returns: v.union(v.null(), v.object({ phone: v.string() })),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.waitlistId);
    // Only a row still let in: one removed since Let in is not told.
    if (row === null || row.status !== "admitted" || row.phone === undefined) return null;
    return { phone: row.phone };
  },
});

export const sendAdmitted = internalAction({
  args: { waitlistId: v.id("waitlist") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const log = (event: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ event: `waitlist_text_${event}`, waitlistId: args.waitlistId, ...extra }));
    const origin = validAppOrigin();
    if (origin === null) {
      log("skipped", { reason: "app_origin_unset" });
      return null;
    }
    const sms = await smsKeys(ctx);
    if (sms === null) {
      log("skipped", { reason: "no_messaging_service" });
      return null;
    }
    const facts = await ctx.runQuery(internal.functions.waitlistText.textFacts, { waitlistId: args.waitlistId });
    if (facts === null) return null;
    const result = await sendTwilioSms(sms, facts.phone, admittedText(new URL("/login", origin).toString()));
    log(result.ok ? "sent" : "failed", result.ok ? {} : { reason: result.reason });
    return null;
  },
});
