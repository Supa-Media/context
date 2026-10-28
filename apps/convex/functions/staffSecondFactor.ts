/**
 * The staff console's second factor: enrolling an authenticator app, and the
 * per-session code check every staff page then waits on
 * (`lib/staffFactor.ts`; docs/decisions/identity-and-access/staff-second-factor.md).
 *
 * These are the only functions a staff account reaches on its first factor
 * alone (`requireStaffIdentity`), because they are the way in. A wrong code
 * is answered, not thrown, so the count of wrong tries commits.
 */

import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isAdminEmail, parseAdminEmails, requireStaffIdentity, ADMIN_EMAILS_ENV_VAR } from "./lib/admin";
import { liveSessionOf } from "./lib/emailProof";
import {
  hasStaffStepUp,
  secondFactorRequired,
  STAFF_STEP_UP_MS,
  STAFF_TRIES_WINDOW_MS,
  STAFF_WRONG_TRIES,
  staffFactorKey,
  staffFactorOf,
  staffFactorStanding,
} from "./lib/staffFactor";
import { base32Encode, matchTotp, otpauthUri } from "./lib/totp";

const standing = v.union(v.literal("enroll"), v.literal("step_up"), v.literal("open"));

/**
 * What the console shows a signed-in person before any staff page: nothing
 * for somebody who is not staff, and for staff whether they are enrolled and
 * whether this session still owes a code.
 */
export const myStaffFactor = query({
  args: {},
  returns: v.union(
    v.object({ staff: v.literal(false) }),
    v.object({
      staff: v.literal(true),
      enrolled: v.boolean(),
      required: v.boolean(),
      standing,
      /** Only to the session that started enrolling, until it types a code. */
      setupUri: v.optional(v.string()),
      setupKey: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    let userId: Id<"users">;
    let email: string;
    try {
      ({ userId, email } = await requireStaffIdentity(ctx));
    } catch {
      return { staff: false as const };
    }
    const factor = await staffFactorOf(ctx, userId);
    const enrolled = factor?.confirmedAt !== undefined;
    const result = {
      staff: true as const,
      enrolled,
      required: secondFactorRequired(),
      standing: await staffFactorStanding(ctx, userId),
    };
    const setup = factor === null ? null : enrolled ? (factor.pending ?? null) : factor;
    if (setup === null) return result;
    const sessionId = await liveSessionOf(ctx, userId);
    if (sessionId === null || sessionId !== setup.startedBySession) return result;
    const key = await staffFactorKey(userId, setup.nonce);
    if (key === null) return result;
    const setupKey = base32Encode(key);
    return { ...result, setupKey, setupUri: otpauthUri(setupKey, email) };
  },
});

/**
 * Start (or restart) enrolling: a fresh key, shown only to this session. An
 * account already enrolled must have typed a code in this session first, so a
 * stolen email code cannot swap the key for the thief's, and its current key
 * stays in force until the new one is confirmed.
 */
export const startEnrollment = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const { userId } = await requireStaffIdentity(ctx);
    const sessionId = await liveSessionOf(ctx, userId);
    if (sessionId === null) throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Sign in again." });
    const existing = await staffFactorOf(ctx, userId);
    if (existing?.confirmedAt !== undefined && !(await hasStaffStepUp(ctx, userId))) {
      throw new ConvexError({ code: "STEP_UP_REQUIRED", message: "Type a code from your current authenticator first." });
    }
    if (existing?.confirmedAt !== undefined) {
      await ctx.db.patch(existing._id, { pending: { nonce: freshNonce(), startedBySession: sessionId } });
      console.log(JSON.stringify({ event: "staff.second_factor_replacing", userId }));
      return null;
    }
    if (existing !== null) await ctx.db.delete(existing._id);
    await ctx.db.insert("staffSecondFactors", {
      userId,
      nonce: freshNonce(),
      startedBySession: sessionId,
      lastUsedStep: 0,
      wrongTries: 0,
      triesWindowStartedAt: Date.now(),
    });
    console.log(JSON.stringify({ event: "staff.second_factor_enrolling", userId }));
    return null;
  },
});

const outcome = v.union(
  v.object({ ok: v.literal(true) }),
  v.object({ ok: v.literal(false), reason: v.union(v.literal("wrong"), v.literal("wait"), v.literal("not_enrolling")) }),
);

/**
 * Type a code. For a pending key this confirms it (from the session that
 * started it); for a confirmed key it opens the staff pages for this session.
 */
export const submitCode = mutation({
  args: { code: v.string() },
  returns: outcome,
  handler: async (ctx, args) => {
    const { userId } = await requireStaffIdentity(ctx);
    const sessionId = await liveSessionOf(ctx, userId);
    if (sessionId === null) throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Sign in again." });
    const factor = await staffFactorOf(ctx, userId);
    if (factor === null) return { ok: false as const, reason: "not_enrolling" as const };
    const pending = factor.confirmedAt === undefined;
    if (pending && factor.startedBySession !== sessionId) return { ok: false as const, reason: "not_enrolling" as const };
    // The session replacing a key types a code from the new one; every other session, from the current one.
    const replacing = !pending && factor.pending?.startedBySession === sessionId ? factor.pending : null;

    const now = Date.now();
    const windowOpen = now - factor.triesWindowStartedAt < STAFF_TRIES_WINDOW_MS;
    const wrongTries = windowOpen ? factor.wrongTries : 0;
    if (wrongTries >= STAFF_WRONG_TRIES) return { ok: false as const, reason: "wait" as const };

    const key = await staffFactorKey(userId, (replacing ?? factor).nonce);
    const step = key === null ? null : await matchTotp(key, args.code, now);
    if (step === null || (replacing === null && step <= factor.lastUsedStep)) {
      await ctx.db.patch(factor._id, {
        wrongTries: wrongTries + 1,
        triesWindowStartedAt: windowOpen ? factor.triesWindowStartedAt : now,
      });
      console.log(JSON.stringify({ event: "staff.second_factor_wrong", userId }));
      return { ok: false as const, reason: "wrong" as const };
    }

    await ctx.db.patch(factor._id, {
      lastUsedStep: step,
      wrongTries: 0,
      triesWindowStartedAt: now,
      ...(pending ? { confirmedAt: now } : {}),
      ...(replacing === null ? {} : { nonce: replacing.nonce, startedBySession: replacing.startedBySession, pending: undefined }),
    });
    await openForSession(ctx, userId, sessionId, now);
    const event = pending ? "enrolled" : replacing !== null ? "replaced" : "passed";
    console.log(JSON.stringify({ event: `staff.second_factor_${event}`, userId }));
    return { ok: true as const };
  },
});

async function openForSession(ctx: MutationCtx, userId: Id<"users">, sessionId: Id<"authSessions">, now: number) {
  const existing = await ctx.db
    .query("staffStepUps")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();
  if (existing !== null) await ctx.db.delete(existing._id);
  await ctx.db.insert("staffStepUps", { userId, sessionId, until: now + STAFF_STEP_UP_MS });
}

function freshNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

/**
 * Counts for whoever turns `STAFF_SECOND_FACTOR=required` on: how many
 * allowlisted addresses have an account, and how many of those are enrolled.
 * Names nobody. `npx convex run functions/staffSecondFactor:census`.
 */
export const census = internalQuery({
  args: {},
  returns: v.object({ allowlisted: v.number(), accounts: v.number(), enrolled: v.number(), required: v.boolean() }),
  handler: async (ctx) => {
    const allowed = parseAdminEmails(process.env[ADMIN_EMAILS_ENV_VAR]);
    let accounts = 0;
    let enrolled = 0;
    for (const email of allowed) {
      const users = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .collect();
      for (const user of users) {
        if (user.emailVerificationTime === undefined || !isAdminEmail(user.email)) continue;
        accounts += 1;
        if ((await staffFactorOf(ctx, user._id))?.confirmedAt !== undefined) enrolled += 1;
      }
    }
    return { allowlisted: allowed.size, accounts, enrolled, required: secondFactorRequired() };
  },
});

/**
 * A lost authenticator: forget the key so the person can enroll again. Only
 * from the deploy key (`npx convex run`), never from the console, the same
 * place `ADMIN_EMAILS` is changed.
 */
export const resetForEmail = internalMutation({
  args: { email: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const users = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email.trim().toLowerCase()))
      .collect();
    let removed = 0;
    for (const user of users) {
      const factor = await staffFactorOf(ctx, user._id);
      if (factor !== null) {
        await ctx.db.delete(factor._id);
        removed += 1;
      }
      const stepUps = await ctx.db.query("staffStepUps").collect();
      for (const stepUp of stepUps) if (stepUp.userId === user._id) await ctx.db.delete(stepUp._id);
      console.log(JSON.stringify({ event: "staff.second_factor_reset", userId: user._id }));
    }
    return removed;
  },
});
