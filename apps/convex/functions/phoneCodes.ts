import { checkTwilioVerification, sendTwilioSms, sendTwilioVerification, twilioSmsKeys } from "@supa-media/convex/auth";
import type { TwilioCheckResult, TwilioSendResult } from "@supa-media/convex/auth";
import { v } from "convex/values";
import { internalMutation, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { contextVerifyKeys } from "./lib/phoneCheck";

/**
 * Sign-in codes in Context's own words (Dev2, 2026-10-09).
 *
 * Twilio Verify wrote "Your togather verification code", because the Verify
 * service is shared with Togather and signs codes with its name, and it
 * refused a per-text name (#1427, undone in #1432). So Context texts the code
 * itself, from its own number (`TWILIO_FROM_NUMBER`), and keeps a hash of it
 * here to check against.
 *
 * Until that number is configured, codes still go through Verify, and a code
 * Verify sent is still checked by Verify: a code is checked by whoever sent
 * it, so switching over never strands a code already on someone's phone.
 */

const CODE_LIFETIME_MS = 10 * 60 * 1000;
/** Wrong codes allowed against one texted code; the per-hour limits sit on top. */
const MAX_ATTEMPTS = 5;

/** Six digits, every one equally likely. */
export function newCode(): string {
  const buffer = new Uint32Array(1);
  // Rejection sampling: 4,294,000,000 is the largest multiple of 1,000,000 under 2^32.
  do crypto.getRandomValues(buffer);
  while (buffer[0]! >= 4_294_000_000);
  return String(buffer[0]! % 1_000_000).padStart(6, "0");
}

export async function hashCode(phone: string, code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${phone}:${code}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The text: the code first, so a lock screen shows it, then the web's autofill line. */
export function codeText(code: string, appOrigin: string | undefined = process.env.APP_ORIGIN): string {
  let host: string | null = null;
  try {
    host = appOrigin ? new URL(appOrigin).host : null;
  } catch {
    host = null;
  }
  const text = `${code} is your Context code. It expires in 10 minutes.`;
  return host ? `${text}\n\n@${host} #${code}` : text;
}

/** Whether a code can be texted at all, by either route. */
export function canTextCodes(): boolean {
  return twilioSmsKeys() !== null || contextVerifyKeys() !== null;
}

/** Text a sign-in code to `phone` (E.164): Context's own words when it has a number. */
export async function textCode(ctx: ActionCtx, phone: string): Promise<TwilioSendResult> {
  const sms = twilioSmsKeys();
  if (sms === null) {
    const verify = contextVerifyKeys();
    return verify === null ? { ok: false, reason: "failed" } : await sendTwilioVerification(verify, phone);
  }
  const code = newCode();
  await ctx.runMutation(internal.functions.phoneCodes.issue, {
    phone,
    codeHash: await hashCode(phone, code),
    expiresAt: Date.now() + CODE_LIFETIME_MS,
  });
  return await sendTwilioSms(sms, phone, codeText(code));
}

/** Whether `code` is the one texted to `phone`. Spends it when it is. */
export async function checkCode(ctx: ActionCtx, phone: string, code: string): Promise<TwilioCheckResult> {
  const own: "approved" | "wrong" | "too_many" | "none" = await ctx.runMutation(internal.functions.phoneCodes.consume, {
    phone,
    codeHash: await hashCode(phone, code),
  });
  if (own !== "none") return own;
  // No code of ours for this phone: Verify sent it, before or without a number.
  const verify = contextVerifyKeys();
  return verify === null ? "wrong" : await checkTwilioVerification(verify, phone, code);
}

/** Keep `codeHash` as the one code for `phone`, replacing any earlier one. */
export const issue = internalMutation({
  args: { phone: v.string(), codeHash: v.string(), expiresAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { phone, codeHash, expiresAt }) => {
    for (const row of await ctx.db
      .query("phoneCodes")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .take(10)) {
      await ctx.db.delete(row._id);
    }
    await ctx.db.insert("phoneCodes", { phone, codeHash, expiresAt, attempts: 0 });
    // Expired rows of other phones are swept a few at a time as codes are issued.
    for (const stale of await ctx.db
      .query("phoneCodes")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now()))
      .take(20)) {
      await ctx.db.delete(stale._id);
    }
    return null;
  },
});

/** Check a code against the one texted to `phone`; `none` when Context texted it none. */
export const consume = internalMutation({
  args: { phone: v.string(), codeHash: v.string() },
  returns: v.union(v.literal("approved"), v.literal("wrong"), v.literal("too_many"), v.literal("none")),
  handler: async (ctx, { phone, codeHash }) => {
    const row = await ctx.db
      .query("phoneCodes")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (row === null) return "none";
    if (row.expiresAt <= Date.now()) {
      await ctx.db.delete(row._id);
      return "wrong";
    }
    if (row.attempts >= MAX_ATTEMPTS) return "too_many";
    if (row.codeHash === codeHash) {
      await ctx.db.delete(row._id);
      return "approved";
    }
    await ctx.db.patch(row._id, { attempts: row.attempts + 1 });
    return "wrong";
  },
});
