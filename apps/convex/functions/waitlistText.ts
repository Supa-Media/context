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
import { greetByTex } from "./texGreeting";
import { putOnTexLine } from "./waitlistTex";

/**
 * What the text says; `signInUrl` is the deployment's /login. It comes from
 * the Messaging Service, not from Tex's line, so a reply reaches nobody:
 * `texLine` is Tex's own number, named only once this phone is on Tex's list
 * (`waitlistTex.ts`), so "text Tex" is never an invitation the line ignores.
 */
export function admittedText(signInUrl: string, texLine: string | null = null): string {
  if (texLine !== null) {
    return `You're in! Text Tex at ${texLine} and Tex will set you up, or sign in with this phone number at ${signInUrl}`;
  }
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
    // On Tex's list before the text names Tex, whether or not a text goes.
    const texLine = await putOnTexLine(ctx, args.waitlistId);
    // Tex texting first says "you're in" itself, from the line they answer.
    if (texLine !== null) {
      const facts = await ctx.runQuery(internal.functions.waitlistText.textFacts, { waitlistId: args.waitlistId });
      if (facts !== null && (await greetByTex(ctx, args.waitlistId, facts.phone, texLine))) {
        log("skipped", { reason: "tex_greeted" });
        return null;
      }
    }
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
    const result = await sendTwilioSms(sms, facts.phone, admittedText(new URL("/login", origin).toString(), texLine));
    log(result.ok ? "sent" : "failed", result.ok ? {} : { reason: result.reason });
    return null;
  },
});
