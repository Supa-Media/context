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
 * Somebody let in by address gets it too, once their phone is on Tex's line
 * (at Let in when their account already has one, else when they confirm
 * one): Tex cannot text first (Dev2, 2026-10-17: "we have to have people
 * texting Tex first, so using twilio we should ask people to text this
 * number"), so this text is how everyone let in learns where Tex is.
 *
 * It goes through the same Messaging Service as sign-in codes. Twilio Verify
 * can only send codes, so with no Messaging Service set the text is skipped
 * and the log says why; the number never appears in the log.
 */

import { sendTwilioSms } from "@supa-media/convex/auth";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { validAppOrigin } from "./lib/invitationEmail";
import { smsKeys } from "./phoneCodes";
import { putOnTexLine } from "./waitlistTex";

/**
 * What the text says; `signInUrl` is the deployment's /login, named only
 * when Tex's number is not. It comes from
 * the Messaging Service, not from Tex's line, so a reply reaches nobody:
 * `texLine` is Tex's own number, named only once this phone is on Tex's list
 * (`waitlistTex.ts`), so "text Tex" is never an invitation the line ignores.
 */
export function admittedText(signInUrl: string, texLine: string | null = null): string {
  if (texLine !== null) {
    // One call to action: the sign-in link started a different setup from
    // texting Tex, which confused new people (onboarding test, 2026-10-17).
    return `You're in! Text Tex at ${readableLine(texLine)} and Tex will set you up.`;
  }
  return `You're in! Context is ready for you. Sign in with this phone number at ${signInUrl}`;
}

/**
 * Tex's number as people write it, country code first so a phone draws it as
 * a number to tap (Dev2, 2026-10-18): `+1 (555) 555-0199` for a North American
 * number, the E.164 form for any other.
 */
export function readableLine(e164: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return us === null ? e164 : `+1 (${us[1]}) ${us[2]}-${us[3]}`;
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

/**
 * Claim the one "You're in" text for a row whose phone came from its account
 * rather than the row: `false` when the row is no longer let in, or was texted.
 */
export const claimText = internalMutation({
  args: { waitlistId: v.id("waitlist") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.waitlistId);
    if (row === null || row.status !== "admitted" || row.admittedTextAt !== undefined) return false;
    await ctx.db.patch(args.waitlistId, { admittedTextAt: Date.now() });
    return true;
  },
});

/**
 * "Text Tex at …" to `phone`, now on Tex's line as `texLine`, at most once
 * per row. For a row let in by address; a phone row is texted by
 * `sendAdmitted`. Never throws.
 */
export async function textTexNumber(
  ctx: ActionCtx,
  waitlistId: Id<"waitlist">,
  phone: string,
  texLine: string,
): Promise<void> {
  const log = (event: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event: `waitlist_text_${event}`, waitlistId, ...extra }));
  try {
    const origin = validAppOrigin();
    const sms = await smsKeys(ctx);
    if (origin === null || sms === null) {
      log("skipped", { reason: origin === null ? "app_origin_unset" : "no_messaging_service" });
      return;
    }
    if (!(await ctx.runMutation(internal.functions.waitlistText.claimText, { waitlistId }))) return;
    const result = await sendTwilioSms(sms, phone, admittedText(new URL("/login", origin).toString(), texLine));
    log(result.ok ? "sent" : "failed", result.ok ? {} : { reason: result.reason });
  } catch {
    log("failed", { reason: "unexpected" });
  }
}
