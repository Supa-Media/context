import type { QueryCtx } from "../../_generated/server";

/**
 * The sign-in a Claude or ChatGPT directory reviewer uses.
 *
 * Both directories test a connector by signing in as an account we hand
 * them, and neither can read our email or pass a second step. So this
 * address signs in with a fixed code, through a provider of its own that
 * refuses every other address.
 *
 * The address is public, because the sign-in screen has to route it to that
 * provider. The code is not: it comes from `REVIEWER_SIGNIN_CODE` on the
 * deployment, and with no valid code no provider is registered at all, so
 * the address signs in like any customer's (by an emailed code). A malformed
 * value is skipped rather than thrown, because a throw here would take every
 * customer's sign-in down with it.
 *
 * The account holds no privileges: `isProductionTestAccount` names only the
 * CUJ address. The App Store review phone signs in with the same code.
 */

export const REVIEWER_EMAIL = "connector-review@supa.media";
export const REVIEWER_PROVIDER_ID = "test-email-reviewer";

type Environment = Record<string, string | undefined>;

export function reviewerTestEmail(
  env: Environment = process.env,
): Array<{ email: string; code: string; id: string }> {
  const code = env.REVIEWER_SIGNIN_CODE?.trim() ?? "";
  if (code === "") return [];
  if (!/^\d{6}$/.test(code) || code === "000000") {
    console.error("REVIEWER_SIGNIN_CODE is not a six-digit code other than 000000; the reviewer sign-in is off.");
    return [];
  }
  return [{ email: REVIEWER_EMAIL, code, id: REVIEWER_PROVIDER_ID }];
}

/** Reserved fictional NANP number. This alias never proves ownership of a phone. */
export const APP_REVIEW_PHONE = "+12025550123";

export function appReviewPhoneEnabled(): boolean {
  return reviewerTestEmail().length === 1;
}

/**
 * Does `code` open the App Store review phone? Only the deployment's own
 * `REVIEWER_SIGNIN_CODE`: the phone used to take a public `000000`, which
 * opened the reviewer account to anyone who read this file (owner,
 * 2026-10-25).
 */
export function appReviewPhoneCodeMatches(code: string, env: Environment = process.env): boolean {
  const reviewer = reviewerTestEmail(env)[0];
  return reviewer !== undefined && code === reviewer.code;
}

/** Resolve only the existing, verified primary reviewer identity. Never provision. */
export async function appReviewUser(ctx: QueryCtx) {
  if (!appReviewPhoneEnabled()) return null;
  const users = await ctx.db.query("users").withIndex("by_email", q => q.eq("email", REVIEWER_EMAIL)).take(2);
  if (users.length !== 1 || users[0]!.emailVerificationTime === undefined || users[0]!.isActive === false) return null;
  const phones = await ctx.db.query("users").withIndex("by_phone", q => q.eq("phone", APP_REVIEW_PHONE)).take(2);
  const link = await ctx.db.query("phoneLinks").withIndex("by_phone", q => q.eq("phone", APP_REVIEW_PHONE)).first();
  // Fail closed if the reserved alias was assigned elsewhere, including an unverified claim.
  if (phones.some(user => user._id !== users[0]!._id) || (link && link.userId !== users[0]!._id)) return null;
  return users[0]!._id;
}
