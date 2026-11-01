import { getAuthUserId } from "./lib/signedIn";
import { ConvexError, v } from "convex/values";
import { action, query } from "../_generated/server";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { canTextCodes, checkCode, textCode } from "./phoneCodes";
import {
  hasConfirmedPhone,
  isExemptEmail,
  normalizePhone,
  phoneCheckRequired,
  phoneHeldByAnother,
} from "./lib/phoneCheck";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { attachedEmailsOf } from "./lib/signInEmails";
import { joinOnPhone, phoneJoinFor } from "./lib/account/phoneJoin";
import { currentPhoneOf, requireEmailProof } from "./lib/emailProof";
import { admittedRowOf } from "./waitlistTex";
import { joinedThroughDomain } from "./lib/accountSetup";
import type { MutationCtx, QueryCtx } from "../_generated/server";

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
  v.literal("has_account"),
);
type SendResult = {
  status: "sent" | "invalid_phone" | "taken" | "too_many" | "failed" | "not_needed" | "has_account";
  phone?: string;
};
type ConfirmResult = { status: "confirmed" | "joined" | "wrong" | "taken" | "too_many" | "failed" | "has_account" };

/**
 * "joined": the number was another account's, and this one (owning nothing)
 * closed into it (`lib/account/phoneJoin.ts`). The person signs in again.
 * "has_account": the number's account already has an email, so a texted code
 * alone may not join anything to it; the person signs in with the phone.
 */
const confirmStatus = v.union(
  v.literal("confirmed"),
  v.literal("joined"),
  v.literal("wrong"),
  v.literal("taken"),
  v.literal("too_many"),
  v.literal("failed"),
  v.literal("has_account"),
);

function requireSignedIn(userId: Id<"users"> | null): Id<"users"> {
  if (userId === null) throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  return userId;
}

/**
 * Whether the app should stop and ask this person for a phone, or, for an
 * account a phone made (`phoneSignIn.ts`), for the email it has not got yet.
 */
export const myPhoneCheck = query({
  args: {},
  returns: v.object({
    required: v.boolean(),
    confirmed: v.boolean(),
    needsEmail: v.boolean(),
    /** Whether the phone step shows "Skip for now": asked, and not a domain joiner. */
    canSkip: v.boolean(),
    /** The phone this account signs in with, for Account settings. Its own, so not a lookup. */
    phone: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const none: { required: boolean; confirmed: boolean; needsEmail: boolean; canSkip: boolean; phone?: string } = {
      required: false,
      confirmed: false,
      needsEmail: false,
      canSkip: false,
    };
    if (userId === null) return none;
    const user = await ctx.db.get(userId);
    if (user === null) return none;
    const confirmed = await hasConfirmedPhone(ctx, user);
    const asked = phoneCheckRequired() && !isExemptEmail(user.email) && !confirmed;
    const mustHave = asked && (await joinedThroughDomain(ctx, userId));
    const required = asked && (mustHave || !(await hasSkipped(ctx, userId)));
    const needsEmail = user.email === undefined && (await attachedEmailsOf(ctx, userId)).length === 0;
    const phone = await currentPhoneOf(ctx, user);
    return { required, confirmed, needsEmail, canSkip: required && !mustHave, ...(phone === null ? {} : { phone }) };
  },
});

async function hasSkipped(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  const row = await ctx.db
    .query("phoneCheckSkips")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return row !== null;
}

/**
 * "Skip for now" on the phone step: saved on the account so it is not asked
 * again anywhere. Refused for someone who joined through a work domain, who
 * needs a phone to keep their account if they leave it (`accountSetup.ts`).
 */
export const skipPhoneCheck = mutation({
  args: {},
  returns: v.object({ status: v.union(v.literal("skipped"), v.literal("not_allowed")) }),
  handler: async (ctx) => {
    const userId = requireSignedIn(await getAuthUserId(ctx));
    if (await joinedThroughDomain(ctx, userId)) return { status: "not_allowed" as const };
    if (!(await hasSkipped(ctx, userId))) await ctx.db.insert("phoneCheckSkips", { userId, skippedAt: Date.now() });
    return { status: "skipped" as const };
  },
});

/**
 * Spend one send for this person and this phone, and say whether the phone
 * may be confirmed by them at all. Both limits are spent only when both have
 * room, so a refusal on one does not use up the other.
 */
export const reserveSend = internalMutation({
  args: { userId: v.id("users"), phone: v.string() },
  returns: v.union(
    v.literal("ok"),
    v.literal("taken"),
    v.literal("too_many"),
    v.literal("not_needed"),
    v.literal("has_account"),
  ),
  handler: async (ctx, { userId, phone }) => {
    const user = await ctx.db.get(userId);
    if (user === null) return "not_needed";
    const current = await currentPhoneOf(ctx, user);
    if (current === phone) return "not_needed";
    if (current !== null) {
      // Changing the phone is a big change: the new number signs in from
      // then on. Asked before a text is spent, and again when it is recorded.
      await requireEmailProof(ctx, userId);
      if (await phoneHeldByAnother(ctx, phone, userId)) return "taken";
    } else {
      const join = (await phoneJoinFor(ctx, userId, phone)).kind;
      if (join === "blocked") return "taken";
      if (join === "guarded") return "has_account";
    }
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
    if (!canTextCodes()) return { status: "failed" as const };
    const phone = normalizePhone(args.phone);
    if (phone === null) return { status: "invalid_phone" as const };
    let reserved: "ok" | "taken" | "too_many" | "not_needed" | "has_account";
    try {
      reserved = await ctx.runMutation(internal.functions.phoneCheck.reserveSend, { userId, phone });
    } catch (error) {
      if (error instanceof ConvexError && (error.data as { code?: string }).code === "RATE_LIMITED") {
        return { status: "too_many" as const };
      }
      throw error;
    }
    if (reserved !== "ok") return { status: reserved };
    const sent = await textCode(ctx, phone);
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
 * Record a phone Twilio approved. The holder check runs again here, in the
 * transaction that writes, because two accounts could each have been texted
 * a code for the same number before either confirmed it. A number another
 * account holds joins the two when one of them owns nothing.
 */
export const recordConfirmedPhone = internalMutation({
  args: { userId: v.id("users"), phone: v.string() },
  returns: v.union(v.literal("confirmed"), v.literal("joined"), v.literal("taken"), v.literal("has_account")),
  handler: async (ctx, { userId, phone }) => {
    // Somebody let in by address has no phone on Tex's list until now.
    // A changed phone frees the old number's slot, so a person holds one.
    const admitted = await admittedRowOf(ctx, userId);
    const before = await ctx.db.get(userId);
    const previous = before === null ? null : await currentPhoneOf(ctx, before);
    const recorded = await recordPhone(ctx, userId, phone);
    if (admitted !== null && (recorded === "confirmed" || recorded === "joined")) {
      await ctx.scheduler.runAfter(0, internal.functions.waitlistTex.putOnLine, {
        waitlistId: admitted,
        phone,
        actorUserId: userId,
        ...(previous !== null && previous !== phone ? { replaces: previous } : {}),
      });
    }
    return recorded;
  },
});

async function recordPhone(
  ctx: MutationCtx,
  userId: Id<"users">,
  phone: string,
): Promise<"confirmed" | "joined" | "taken" | "has_account"> {
  const user = await ctx.db.get(userId);
  const current = user === null ? null : await currentPhoneOf(ctx, user);
  if (current !== null && current !== phone) return await changePhone(ctx, userId, phone);
  const join = await phoneJoinFor(ctx, userId, phone);
  if (join.kind === "blocked") return "taken";
  if (join.kind === "guarded") return "has_account";
  if (join.kind !== "free") {
    await joinOnPhone(ctx, userId, phone, join);
    return join.kind === "into" ? "joined" : "confirmed";
  }
  if (await phoneHeldByAnother(ctx, phone, userId)) return "taken";
  await ctx.db.patch(userId, { phone, phoneVerificationTime: Date.now() });
  return "confirmed";
}

/** Confirm the code texted to `phone`. */
export const confirmPhoneCode = action({
  args: { phone: v.string(), code: v.string() },
  returns: v.object({ status: confirmStatus }),
  handler: async (ctx, args): Promise<ConfirmResult> => {
    const userId = requireSignedIn((await getAuthUserId(ctx)) as Id<"users"> | null);
    if (!canTextCodes()) return { status: "failed" as const };
    const phone = normalizePhone(args.phone);
    const code = args.code.replace(/\s/g, "");
    if (phone === null || !/^\d{4,10}$/.test(code)) return { status: "wrong" as const };
    if (!(await ctx.runMutation(internal.functions.phoneCheck.spendCheck, { userId }))) {
      return { status: "too_many" as const };
    }
    const checked = await checkCode(ctx, phone, code);
    if (checked !== "approved") return { status: checked };
    const recorded: "confirmed" | "joined" | "taken" | "has_account" = await ctx.runMutation(internal.functions.phoneCheck.recordConfirmedPhone, { userId, phone });
    return { status: recorded };
  },
});

/**
 * Move the account to a new phone (board k4): needs an emailed code from this
 * session, never joins accounts, and takes texting along, so the assistant
 * answers the new number and stops answering the old one.
 */
async function changePhone(ctx: MutationCtx, userId: Id<"users">, phone: string): Promise<"confirmed" | "taken"> {
  await requireEmailProof(ctx, userId);
  if (await phoneHeldByAnother(ctx, phone, userId)) return "taken";
  await ctx.db.patch(userId, { phone, phoneVerificationTime: Date.now() });
  const links = await ctx.db
    .query("phoneLinks")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const link of links) await ctx.db.patch(link._id, { phone, linkedAt: Date.now() });
  return "confirmed";
}
