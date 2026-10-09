import { sendTwilioVerification, twilioVerifyKeys } from "@supa-media/convex/auth";
import { ConvexError, v } from "convex/values";
import { action, internalMutation } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizePhone } from "./lib/phoneCheck";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { isPhoneAdmitted } from "./lib/waitlist";
import { scheduleSignupAlert } from "./signupAlerts";
import { scheduleXConversion } from "./xConversions";
import { scheduleMetaConversion } from "./metaConversions";
import { WAITLIST_JOINS_PER_HOUR } from "./waitlist";
import { landingPageOf } from "@context/shared";

/**
 * Signing in, and joining the waitlist, with a phone (Dev2, 2026-10-09:
 * "switch things to sign in with phone number", then "login and waitlist sign
 * up"). The sign-in page asks for a phone first.
 *
 *  - A phone an account holds gets a texted code, and the code signs in
 *    through the `phone-verify` provider (`auth.ts`, `@supa-media/convex`):
 *    Twilio checks it, `signInUser` below says whose phone it is.
 *  - A phone staff let in from the waitlist gets a texted code too, and the
 *    code makes its account: the phone is confirmed by that code, so the
 *    account starts with it. The app then asks for an email once.
 *  - Any other phone goes on the waitlist and is texted nothing. So a
 *    stranger can only make us text numbers an account holds or staff let
 *    in, which is what keeps this public action from being an SMS pump.
 *
 * A phone counts as held when it is confirmed on the account (`users.phone`
 * with `phoneVerificationTime`, by a texted code or typed by staff) or linked
 * for texting (`phoneLinks`). One phone is one account (`phoneHeldByAnother`).
 *
 * Saying "joined" or "already" tells a caller whether a number is on the list
 * and has no account, as `waitlist.enter` does for an address (decided by
 * Dev2 for addresses, 2026-09-29). Both are rate limited; neither says whose.
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
  v.literal("joined"),
  v.literal("already"),
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

/** Put `phone` on the waitlist, or say it already is. */
async function joinWaitlist(
  ctx: MutationCtx,
  phone: string,
  landing: string | undefined,
): Promise<"joined" | "already" | "too_many"> {
  const existing = await ctx.db
    .query("waitlist")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .first();
  if (existing !== null) return "already";
  // The same deployment-wide cap as joining with an address.
  if (!(await tryConsumeRateLimit(ctx, { key: "waitlist.join", limit: WAITLIST_JOINS_PER_HOUR, windowMs: WINDOW_MS }))) {
    return "too_many";
  }
  const page = landingPageOf(landing);
  const id = await ctx.db.insert("waitlist", {
    phone,
    status: "waiting",
    joinedAt: Date.now(),
    source: "login",
    ...(page === undefined ? {} : { landing: page }),
  });
  await scheduleSignupAlert(ctx, { kind: "waitlist", waitlistId: id });
  return "joined";
}

/**
 * Whether `phone` may be texted a sign-in code, spending one send when it
 * may. A phone that may not joins the waitlist instead, and is texted nothing.
 */
export const reserveSend = internalMutation({
  args: { phone: v.string(), landing: v.optional(v.string()) },
  returns: v.union(v.literal("ok"), v.literal("joined"), v.literal("already"), v.literal("too_many")),
  handler: async (ctx, { phone, landing }) => {
    if (!(await tryConsumeRateLimit(ctx, { key: "phoneSignIn.lookup", limit: LOOKUPS_PER_HOUR, windowMs: WINDOW_MS }))) {
      return "too_many";
    }
    if ((await phoneHolder(ctx, phone)) === null && !(await isPhoneAdmitted(ctx.db, phone))) {
      return await joinWaitlist(ctx, phone, landing);
    }
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

/**
 * The account a phone Twilio just approved signs in to, for the provider in
 * `auth.ts`. Runs only after that approval. A phone no account holds makes
 * one only when staff let it in, and then the account starts with the phone
 * confirmed. Anything else is `null`, which refuses the sign-in.
 */
export const signInUser = internalMutation({
  args: { phone: v.string() },
  returns: v.union(v.id("users"), v.null()),
  handler: async (ctx, { phone }) => {
    const held = await phoneHolder(ctx, phone);
    if (held !== null) return held;
    if (!(await isPhoneAdmitted(ctx.db, phone))) return null;
    const now = Date.now();
    const userId = await ctx.db.insert("users", { phone, phoneVerificationTime: now, isActive: true, createdAt: now });
    // What `onUserCreated` does for an account made by email (`auth.ts`).
    await scheduleSignupAlert(ctx, { kind: "account", userId });
    await scheduleXConversion(ctx, { kind: "account", userId });
    await scheduleMetaConversion(ctx, { kind: "account", userId });
    return userId;
  },
});

/** Spend one code check for `phone`; asked by the provider before Twilio is. */
export const spendCheck = internalMutation({
  args: { phone: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { phone }) =>
    await tryConsumeRateLimit(ctx, { key: `phoneSignIn.check:${phone}`, limit: CHECK_PER_PHONE, windowMs: WINDOW_MS }),
});

/** The sign-in page's first step: text a code, or put the phone on the list. */
export const start = action({
  // `landing` is the page the person saw; it is kept only if they join.
  args: { phone: v.string(), landing: v.optional(v.string()) },
  returns: v.object({ status: startStatus, phone: v.optional(v.string()) }),
  handler: async (ctx, args): Promise<{ status: StartStatus; phone?: string }> => {
    const phone = normalizePhone(args.phone);
    if (phone === null) return { status: "invalid_phone" };
    const keys = twilioVerifyKeys();
    if (keys === null) return { status: "unavailable", phone };
    let reserved: "ok" | "joined" | "already" | "too_many";
    try {
      reserved = await ctx.runMutation(internal.functions.phoneSignIn.reserveSend, {
        phone,
        ...(args.landing === undefined ? {} : { landing: args.landing }),
      });
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
