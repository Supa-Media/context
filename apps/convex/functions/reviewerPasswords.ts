import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import {
  MAX_REVIEWER_PASSWORD_MISSES,
  REVIEWER_PASSWORD_LENGTH,
  REVIEWER_PASSWORD_LIFETIME_MS,
  REVIEWER_PASSWORD_MISS_WINDOW_MS,
  hashReviewerPassword,
  newReviewerPassword,
  newSalt,
  passwordAccount,
  sameHash,
} from "./lib/reviewerPassword";
import { sendAccountMail } from "./lib/accountMail";
import { teamInbox } from "./signupAlerts";

/**
 * The password staff set for a review account (`lib/reviewerPassword.ts` says
 * why it exists and what holds it to CASA's controls).
 *
 * `set`, `mailToTeam` and `revoke` are internal: only someone holding the
 * deployment's deploy key runs them, through the "Set a reviewer password"
 * workflow. `check` is internal too, and reached only from the
 * `reviewer-password` sign-in provider in `auth.ts`.
 */

async function accountFor(ctx: MutationCtx, email: string): Promise<Id<"users">> {
  const existing = await ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", email)).unique();
  if (existing !== null) return existing._id;
  // Made here, not by signing in: a credentials sign-in never makes an
  // account. It starts with no workspace, so its first sign-in picks a handle
  // like anyone's. It takes no founding slot (`billing/founding.ts`).
  const now = Date.now();
  return await ctx.db.insert("users", { email, emailVerificationTime: now, isActive: true, createdAt: now });
}

async function rowsFor(ctx: MutationCtx, email: string) {
  return await ctx.db.query("reviewerPasswords").withIndex("by_email", (q) => q.eq("email", email)).collect();
}

const setAnswer = v.object({ email: v.string(), password: v.string(), expiresAt: v.number() });

export const set = internalMutation({
  args: { email: v.string() },
  returns: setAnswer,
  handler: async (ctx, args) => {
    const email = passwordAccount(args.email);
    if (email === null) throw new Error("passwords are set only for the review accounts");
    const userId = await accountFor(ctx, email);
    for (const row of await rowsFor(ctx, email)) await ctx.db.delete(row._id);
    const password = newReviewerPassword();
    const salt = newSalt();
    const now = Date.now();
    const expiresAt = now + REVIEWER_PASSWORD_LIFETIME_MS;
    await ctx.db.insert("reviewerPasswords", {
      email,
      userId,
      salt,
      hash: await hashReviewerPassword(email, salt, password),
      issuedAt: now,
      expiresAt,
      misses: 0,
      missWindowStart: now,
    });
    console.log(JSON.stringify({ event: "reviewerPassword.set", expiresAt }));
    return { email, password, expiresAt };
  },
});

export const mailToTeam = internalAction({
  args: { email: v.string() },
  returns: v.object({ mailed: v.boolean(), expiresAt: v.number() }),
  handler: async (ctx, args): Promise<{ mailed: boolean; expiresAt: number }> => {
    const to = teamInbox();
    if (to === null) throw new Error("SIGNUP_ALERTS_EMAIL names no team inbox; nowhere to send the password.");
    const { email, password, expiresAt } = await ctx.runMutation(internal.functions.reviewerPasswords.set, args);
    const until = new Date(expiresAt).toUTCString();
    await sendAccountMail("reviewerPassword.mailed", {
      to,
      subject: `Password for ${email}`,
      text:
        `Sign in at https://context.lc/login with ${email} and this password:\n\n${password}\n\n` +
        `It expires ${until}. Setting another replaces it; revoking it ends it now. ` +
        `After ten wrong passwords in an hour it refuses everyone until the hour is up. ` +
        `Give it only through the reviewer's private form.\n`,
    });
    return { mailed: true, expiresAt };
  },
});

export const revoke = internalMutation({
  args: { email: v.string() },
  returns: v.object({ revoked: v.number() }),
  handler: async (ctx, args) => {
    const email = passwordAccount(args.email);
    if (email === null) throw new Error("passwords are set only for the review accounts");
    const rows = await rowsFor(ctx, email);
    for (const row of rows) await ctx.db.delete(row._id);
    console.log(JSON.stringify({ event: "reviewerPassword.revoked", count: rows.length }));
    return { revoked: rows.length };
  },
});

/**
 * The account `password` opens, or `null`. Spends a miss for every wrong
 * password, and refuses everything once ten are spent in the hour.
 */
export const check = internalMutation({
  args: { email: v.string(), password: v.string() },
  returns: v.union(v.id("users"), v.null()),
  handler: async (ctx, args) => {
    const email = passwordAccount(args.email);
    if (email === null) return null;
    const [row] = await rowsFor(ctx, email);
    if (row === undefined) return null;
    const now = Date.now();
    if (row.expiresAt <= now) {
      await ctx.db.delete(row._id);
      return null;
    }
    const windowOver = now - row.missWindowStart >= REVIEWER_PASSWORD_MISS_WINDOW_MS;
    const misses = windowOver ? 0 : row.misses;
    if (misses >= MAX_REVIEWER_PASSWORD_MISSES) return null;
    const typed = args.password;
    const right =
      typed.length === REVIEWER_PASSWORD_LENGTH && sameHash(await hashReviewerPassword(email, row.salt, typed), row.hash);
    if (!right) {
      await ctx.db.patch(row._id, { misses: misses + 1, missWindowStart: windowOver ? now : row.missWindowStart });
      console.log(JSON.stringify({ event: "reviewerPassword.miss", misses: misses + 1 }));
      return null;
    }
    const user = await ctx.db.get(row.userId);
    if (user === null || user.email?.trim().toLowerCase() !== email) return null;
    console.log(JSON.stringify({ event: "reviewerPassword.signIn" }));
    return row.userId;
  },
});
