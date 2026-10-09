import { getAuthUserId } from "@convex-dev/auth/server";
import {
  checkTwilioVerification,
  sendTwilioVerification,
  twilioVerifyKeys,
} from "@supa-media/convex/auth";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  hasConfirmedPhone,
  isExemptEmail,
  normalizePhone,
  phoneCheckRequired,
  phoneHeldByAnother,
} from "./lib/phoneCheck";
import { tryConsumeRateLimit } from "./lib/rateLimit";

/**
 * The phone check's three calls: is this person asked, text them a code, and
 * confirm it. The rule, the exemptions and what counts as confirmed are in
 * `lib/phoneCheck.ts`.
 *
 * Twilio Verify holds the code, so nothing secret is stored here. What is
 * stored is the result: `users.phone` and `users.phoneVerificationTime`.
 */

/** Codes texted per person per hour, and per phone number per hour. */
const SEND_LIMIT = 5;
/** Codes typed per person per hour, right or wrong. */
const CHECK_LIMIT = 10;
const WINDOW_MS = 60 * 60 * 1000;

const sendStatus = v.union(
  v.literal("sent"),
  v.literal("invalid_phone"),
  v.literal("taken"),
  v.literal("too_many"),
  v.literal("failed"),
  v.literal("not_needed"),
);
type SendResult = {
  status: "sent" | "invalid_phone" | "taken" | "too_many" | "failed" | "not_needed";
  phone?: string;
};
type ConfirmResult = { status: "confirmed" | "wrong" | "taken" | "too_many" | "failed" };

const confirmStatus = v.union(
  v.literal("confirmed"),
  v.literal("wrong"),
  v.literal("taken"),
  v.literal("too_many"),
  v.literal("failed"),
);

function requireSignedIn(userId: Id<"users"> | null): Id<"users"> {
  if (userId === null) throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  return userId;
}

/** Whether the app should stop and ask this person for a phone. */
export const myPhoneCheck = query({
  args: {},
  returns: v.object({ required: v.boolean(), confirmed: v.boolean() }),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { required: false, confirmed: false };
    const user = await ctx.db.get(userId);
    if (user === null) return { required: false, confirmed: false };
    const confirmed = await hasConfirmedPhone(ctx, user);
    const required = phoneCheckRequired() && !isExemptEmail(user.email) && !confirmed;
    return { required, confirmed };
  },
});

/**
 * Spend one send for this person and this phone, and say whether the phone
 * may be confirmed by them at all. Both limits are spent only when both have
 * room, so a refusal on one does not use up the other.
 */
export const reserveSend = internalMutation({
  args: { userId: v.id("users"), phone: v.string() },
  returns: v.union(v.literal("ok"), v.literal("taken"), v.literal("too_many"), v.literal("not_needed")),
  handler: async (ctx, { userId, phone }) => {
    const user = await ctx.db.get(userId);
    if (user === null || (await hasConfirmedPhone(ctx, user))) return "not_needed";
    if (await phoneHeldByAnother(ctx, phone, userId)) return "taken";
    if (!(await tryConsumeRateLimit(ctx, { key: `phoneCheck.send:${userId}`, limit: SEND_LIMIT, windowMs: WINDOW_MS }))) {
      return "too_many";
    }
    if (!(await tryConsumeRateLimit(ctx, { key: `phoneCheck.sendTo:${phone}`, limit: SEND_LIMIT, windowMs: WINDOW_MS }))) {
      // Rolls back the per-person spend with it: a mutation's writes commit
      // together or not at all, and this one throws.
      throw new ConvexError({ code: "RATE_LIMITED", message: "too_many" });
    }
    return "ok";
  },
});

/** Text a code to `phone`. */
export const sendPhoneCode = action({
  args: { phone: v.string() },
  returns: v.object({ status: sendStatus, phone: v.optional(v.string()) }),
  handler: async (ctx, args): Promise<SendResult> => {
    const userId = requireSignedIn((await getAuthUserId(ctx)) as Id<"users"> | null);
    const keys = twilioVerifyKeys();
    if (keys === null) return { status: "failed" as const };
    const phone = normalizePhone(args.phone);
    if (phone === null) return { status: "invalid_phone" as const };
    let reserved: "ok" | "taken" | "too_many" | "not_needed";
    try {
      reserved = await ctx.runMutation(internal.functions.phoneCheck.reserveSend, { userId, phone });
    } catch (error) {
      if (error instanceof ConvexError && (error.data as { code?: string }).code === "RATE_LIMITED") {
        return { status: "too_many" as const };
      }
      throw error;
    }
    if (reserved !== "ok") return { status: reserved };
    const sent = await sendTwilioVerification(keys, phone);
    return sent.ok ? { status: "sent" as const, phone } : { status: sent.reason };
  },
});

export const spendCheck = internalMutation({
  args: { userId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, { userId }) =>
    await tryConsumeRateLimit(ctx, { key: `phoneCheck.check:${userId}`, limit: CHECK_LIMIT, windowMs: WINDOW_MS }),
});

/**
 * Record a phone Twilio approved. The uniqueness check runs again here, in
 * the transaction that writes, because two accounts could each have been
 * texted a code for the same number before either confirmed it.
 */
export const recordConfirmedPhone = internalMutation({
  args: { userId: v.id("users"), phone: v.string() },
  returns: v.union(v.literal("confirmed"), v.literal("taken")),
  handler: async (ctx, { userId, phone }) => {
    if (await phoneHeldByAnother(ctx, phone, userId)) return "taken";
    await ctx.db.patch(userId, { phone, phoneVerificationTime: Date.now() });
    return "confirmed";
  },
});

/** Confirm the code texted to `phone`. */
export const confirmPhoneCode = action({
  args: { phone: v.string(), code: v.string() },
  returns: v.object({ status: confirmStatus }),
  handler: async (ctx, args): Promise<ConfirmResult> => {
    const userId = requireSignedIn((await getAuthUserId(ctx)) as Id<"users"> | null);
    const keys = twilioVerifyKeys();
    if (keys === null) return { status: "failed" as const };
    const phone = normalizePhone(args.phone);
    const code = args.code.replace(/\s/g, "");
    if (phone === null || !/^\d{4,10}$/.test(code)) return { status: "wrong" as const };
    if (!(await ctx.runMutation(internal.functions.phoneCheck.spendCheck, { userId }))) {
      return { status: "too_many" as const };
    }
    const checked = await checkTwilioVerification(keys, phone, code);
    if (checked !== "approved") return { status: checked };
    const recorded: "confirmed" | "taken" = await ctx.runMutation(internal.functions.phoneCheck.recordConfirmedPhone, { userId, phone });
    return { status: recorded };
  },
});
