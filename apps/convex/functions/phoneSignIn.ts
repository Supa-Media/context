import { sendTwilioVerification, twilioVerifyKeys } from "@supa-media/convex/auth";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizePhone } from "./lib/phoneCheck";
import { tryConsumeRateLimit } from "./lib/rateLimit";

/**
 * Signing in with a phone (Dev2, 2026-10-09: "switch things to sign in with
 * phone number"). The sign-in page asks for a phone first.
 *
 *  - A phone an account holds gets a texted code, and the code signs in
 *    through the `phone-verify` provider (`auth.ts`, `@supa-media/convex`):
 *    Twilio checks it, `holder` below says whose phone it is.
 *  - A phone nobody holds is texted nothing. The page asks for an email, the
 *    ordinary invite-only email sign-in runs, and the phone check then
 *    confirms the phone they typed onto that account (`phoneCheck.ts`). So a
 *    stranger can never make us text a number no account holds, which is
 *    what keeps this public action from being an SMS pump.
 *
 * A phone counts as held when it is confirmed on the account (`users.phone`
 * with `phoneVerificationTime`, by a texted code or typed by staff) or linked
 * for texting (`phoneLinks`). One phone is one account (`phoneHeldByAnother`).
 *
 * Saying "new" for a phone nobody holds does tell a caller whether a number
 * has an account, as `waitlist.enter` does for an address. Both are rate
 * limited; neither says whose.
 */

/** Codes texted to one phone per hour (shared with the phone check). */
const SEND_PER_PHONE = 5;
/** Codes texted for sign-in per hour, everybody together. */
const SEND_PER_HOUR = 300;
/** Phones looked up per hour, everybody together: bounds asking about numbers. */
const LOOKUPS_PER_HOUR = 1000;
/** Codes typed for one phone per hour, right or wrong. */
const CHECK_PER_PHONE = 10;
const WINDOW_MS = 60 * 60 * 1000;

const startStatus = v.union(
  v.literal("sent"),
  v.literal("new"),
  v.literal("invalid_phone"),
  v.literal("too_many"),
  v.literal("unavailable"),
  v.literal("failed"),
);
type StartStatus = typeof startStatus.type;

/** The account `phone` (E.164) signs in to, or `null`. */
export async function phoneHolder(ctx: QueryCtx, phone: string): Promise<Id<"users"> | null> {
  const users = await ctx.db
    .query("users")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .take(10);
  const confirmed = users.find((user) => user.phoneVerificationTime !== undefined);
  if (confirmed !== undefined) return confirmed._id;
  const link = await ctx.db
    .query("phoneLinks")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .first();
  return link?.userId ?? null;
}

export const holder = internalQuery({
  args: { phone: v.string() },
  returns: v.union(v.id("users"), v.null()),
  handler: async (ctx, { phone }) => await phoneHolder(ctx, phone),
});

/**
 * Whether `phone` signs in to an account, spending one send when it does.
 * A phone nobody holds spends only a lookup, since nothing is texted to it.
 */
export const reserveSend = internalMutation({
  args: { phone: v.string() },
  returns: v.union(v.literal("ok"), v.literal("new"), v.literal("too_many")),
  handler: async (ctx, { phone }) => {
    if (!(await tryConsumeRateLimit(ctx, { key: "phoneSignIn.lookup", limit: LOOKUPS_PER_HOUR, windowMs: WINDOW_MS }))) {
      return "too_many";
    }
    if ((await phoneHolder(ctx, phone)) === null) return "new";
    if (!(await tryConsumeRateLimit(ctx, { key: `phoneCheck.sendTo:${phone}`, limit: SEND_PER_PHONE, windowMs: WINDOW_MS }))) {
      return "too_many";
    }
    if (!(await tryConsumeRateLimit(ctx, { key: "phoneSignIn.send", limit: SEND_PER_HOUR, windowMs: WINDOW_MS }))) {
      // Rolls back the other spends with it.
      throw new ConvexError({ code: "RATE_LIMITED", message: "too_many" });
    }
    return "ok";
  },
});

/** Spend one code check for `phone`; asked by the provider before Twilio is. */
export const spendCheck = internalMutation({
  args: { phone: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { phone }) =>
    await tryConsumeRateLimit(ctx, { key: `phoneSignIn.check:${phone}`, limit: CHECK_PER_PHONE, windowMs: WINDOW_MS }),
});

/** The sign-in page's first step: text a code, or say the phone is new. */
export const start = action({
  args: { phone: v.string() },
  returns: v.object({ status: startStatus, phone: v.optional(v.string()) }),
  handler: async (ctx, args): Promise<{ status: StartStatus; phone?: string }> => {
    const phone = normalizePhone(args.phone);
    if (phone === null) return { status: "invalid_phone" };
    const keys = twilioVerifyKeys();
    if (keys === null) return { status: "unavailable", phone };
    let reserved: "ok" | "new" | "too_many";
    try {
      reserved = await ctx.runMutation(internal.functions.phoneSignIn.reserveSend, { phone });
    } catch (error) {
      if (error instanceof ConvexError && (error.data as { code?: string }).code === "RATE_LIMITED") {
        return { status: "too_many" };
      }
      throw error;
    }
    if (reserved !== "ok") return { status: reserved, phone };
    const sent = await sendTwilioVerification(keys, phone);
    if (sent.ok) return { status: "sent", phone };
    return { status: sent.reason === "invalid_phone" ? "invalid_phone" : sent.reason, phone };
  },
});
