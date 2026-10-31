import { ConvexError, v } from "convex/values";
import { action, internalMutation } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizePhone } from "./lib/phoneCheck";
import { canTextCodes, textCode } from "./phoneCodes";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { isPhoneAdmitted } from "./lib/waitlist";
import { scheduleSignupAlert } from "./signupAlerts";
import { scheduleXConversion } from "./xConversions";
import { scheduleMetaConversion } from "./metaConversions";
import { WAITLIST_JOINS_PER_HOUR } from "./waitlist";
import { adCampaignValidator, signUpOrigin } from "./lib/waitlistCampaign";
import { waitlistConversionId } from "./lib/xConversion";
import { phoneSignInPaused } from "./lib/emailProof";
import { APP_REVIEW_PHONE, appReviewPhoneEnabled, appReviewUser } from "./lib/reviewerAccount";
import { scheduleSignInAlert } from "./signInAlerts";
import { newReceipt } from "./lib/waitlistReceipt";

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
  v.literal("paused"),
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

const reservedValidator = v.object({
  status: v.union(v.literal("ok"), v.literal("joined"), v.literal("already"), v.literal("too_many"), v.literal("paused")),
  // On `joined` only: the id the page's X and Meta pixel events report.
  conversionId: v.optional(v.string()),
  // On `joined` only: the row's status receipt (`lib/waitlistReceipt.ts`).
  receipt: v.optional(v.string()),
});
type Reserved = typeof reservedValidator.type;

/** Put `phone` on the waitlist, or say it already is. */
async function joinWaitlist(
  ctx: MutationCtx,
  phone: string,
  origin: { landing?: string; campaign?: unknown },
): Promise<Reserved> {
  const existing = await ctx.db
    .query("waitlist")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .first();
  if (existing !== null) return { status: "already" };
  // The same deployment-wide cap as joining with an address.
  if (!(await tryConsumeRateLimit(ctx, { key: "waitlist.join", limit: WAITLIST_JOINS_PER_HOUR, windowMs: WINDOW_MS }))) {
    return { status: "too_many" };
  }
  const { receipt, receiptHash } = await newReceipt();
  const id = await ctx.db.insert("waitlist", {
    phone,
    status: "waiting",
    joinedAt: Date.now(),
    source: "login",
    receiptHash,
    ...signUpOrigin(origin),
  });
  await scheduleSignupAlert(ctx, { kind: "waitlist", waitlistId: id });
  return { status: "joined", conversionId: waitlistConversionId(id), receipt };
}

/**
 * Whether `phone` may be texted a sign-in code, spending one send when it
 * may. A phone that may not joins the waitlist instead, and is texted nothing.
 */
export const reserveSend = internalMutation({
  args: { phone: v.string(), landing: v.optional(v.string()), campaign: v.optional(adCampaignValidator) },
  returns: reservedValidator,
  handler: async (ctx, { phone, ...origin }): Promise<Reserved> => {
    if (!(await tryConsumeRateLimit(ctx, { key: "phoneSignIn.lookup", limit: LOOKUPS_PER_HOUR, windowMs: WINDOW_MS }))) {
      return { status: "too_many" };
    }
    const holder = phone === APP_REVIEW_PHONE ? await appReviewUser(ctx) : await phoneHolder(ctx, phone);
    if (phone === APP_REVIEW_PHONE && holder === null) return { status: "paused" };
    if (holder === null && !(await isPhoneAdmitted(ctx.db, phone))) {
      return await joinWaitlist(ctx, phone, origin);
    }
    // Paused by "This wasn't me": no text is spent on it.
    if (holder !== null && (await phoneSignInPaused(ctx, holder))) return { status: "paused" };
    if (!(await tryConsumeRateLimit(ctx, { key: `phoneCheck.sendTo:${phone}`, limit: SEND_PER_PHONE, windowMs: WINDOW_MS }))) {
      return { status: "too_many" };
    }
    if (!(await tryConsumeRateLimit(ctx, { key: "phoneSignIn.send", limit: SEND_PER_HOUR, windowMs: WINDOW_MS }))) {
      // Rolls back the other spends with it.
      throw new ConvexError({ code: "RATE_LIMITED", message: "too_many" });
    }
    return { status: "ok" };
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
    // The review alias cannot sign in to an arbitrary phone holder or create an account.
    if (phone === APP_REVIEW_PHONE) {
      const reviewer = await appReviewUser(ctx);
      return reviewer !== null && !(await phoneSignInPaused(ctx, reviewer)) ? reviewer : null;
    }
    const held = await phoneHolder(ctx, phone);
    if (held !== null) {
      // "This wasn't me" paused this phone: it signs nobody in until the
      // person turns it back on from an email sign-in (`signInAlerts.ts`).
      if (await phoneSignInPaused(ctx, held)) return null;
      // Every email on the account hears about it (board k3).
      await scheduleSignInAlert(ctx, held, phone);
      return held;
    }
    if (!(await isPhoneAdmitted(ctx.db, phone))) return null;
    return await newPhoneAccount(ctx, phone);
  },
});

/**
 * The account a phone staff let in makes, with the phone already confirmed by
 * whatever proved it: a texted code (`signInUser`) or an iMessage from it
 * (`textSetup.ts`). The caller has checked the phone is admitted and held by
 * nobody.
 */
export async function newPhoneAccount(
  ctx: MutationCtx,
  phone: string,
  { adConversions = true }: { adConversions?: boolean } = {},
): Promise<Id<"users">> {
  const now = Date.now();
  const userId = await ctx.db.insert("users", { phone, phoneVerificationTime: now, isActive: true, createdAt: now });
  // What `onUserCreated` does for an account made by email (`auth.ts`),
  // founding Premium included: scheduled, so nothing in it fails this.
  await scheduleSignupAlert(ctx, { kind: "account", userId });
  // An account made for someone in a Tex chat (`guestPass.ts`) did not sign up from an ad: no ad network hears of it.
  if (adConversions) {
    await scheduleXConversion(ctx, { kind: "account", userId });
    await scheduleMetaConversion(ctx, { kind: "account", userId });
  }
  await ctx.scheduler.runAfter(0, internal.functions.foundingPremium.catchUp, {});
  return userId;
}

/** Spend one code check for `phone`; asked by the provider before Twilio is. */
export const spendCheck = internalMutation({
  args: { phone: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { phone }) =>
    await tryConsumeRateLimit(ctx, { key: `phoneSignIn.check:${phone}`, limit: CHECK_PER_PHONE, windowMs: WINDOW_MS }),
});

/** The sign-in page's first step: text a code, or put the phone on the list. */
export const start = action({
  // `landing` is the page the person saw and `campaign` the ad that sent
  // them; both are kept only if they join.
  args: { phone: v.string(), landing: v.optional(v.string()), campaign: v.optional(adCampaignValidator) },
  returns: v.object({
    status: startStatus,
    phone: v.optional(v.string()),
    conversionId: v.optional(v.string()),
    // On `joined` only, to the browser that made the row and nobody else.
    receipt: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<{ status: StartStatus; phone?: string; conversionId?: string; receipt?: string }> => {
    const phone = normalizePhone(args.phone);
    if (phone === null) return { status: "invalid_phone" };
    if (phone === APP_REVIEW_PHONE ? !appReviewPhoneEnabled() : !canTextCodes()) return { status: "unavailable", phone };
    let reserved: Reserved;
    try {
      reserved = await ctx.runMutation(internal.functions.phoneSignIn.reserveSend, {
        phone,
        ...(args.landing === undefined ? {} : { landing: args.landing }),
        ...(args.campaign === undefined ? {} : { campaign: args.campaign }),
      });
    } catch (error) {
      if (error instanceof ConvexError && (error.data as { code?: string }).code === "RATE_LIMITED") {
        return { status: "too_many" };
      }
      throw error;
    }
    if (reserved.status !== "ok") return { ...reserved, status: reserved.status, phone };
    if (phone === APP_REVIEW_PHONE) return { status: "sent", phone };
    const sent = await textCode(ctx, phone);
    if (sent.ok) return { status: "sent", phone };
    return { status: sent.reason === "invalid_phone" ? "invalid_phone" : sent.reason, phone };
  },
});
