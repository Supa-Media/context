import type { Id } from "../../_generated/dataModel";
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
 * CUJ address. The App Store review phone may keep its separately submitted
 * code in `APP_REVIEW_SIGNIN_CODE` without changing this email provider.
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

function appReviewPhoneCode(env: Environment): string | undefined {
  const reviewer = reviewerTestEmail(env)[0];
  if (reviewer === undefined) return undefined;
  const code = env.APP_REVIEW_SIGNIN_CODE?.trim() ?? "";
  if (code === "") return reviewer.code;
  return /^\d{6}$/.test(code) ? code : undefined;
}

export function appReviewPhoneEnabled(): boolean {
  return appReviewPhoneCode(process.env) !== undefined;
}

/**
 * Does `code` open the App Store review phone? Only the deployment's own
 * `APP_REVIEW_SIGNIN_CODE`, or the directory code when no separate code is
 * configured. The submitted App Store code stays stable without changing
 * directory or CUJ credentials (owner, 2026-10-25). Both values come from
 * secrets; there is no code embedded here. A malformed override disables the
 * phone alias instead of silently accepting the directory code.
 */
export function appReviewPhoneCodeMatches(code: string, env: Environment = process.env): boolean {
  return code === appReviewPhoneCode(env);
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

/**
 * The sign-in for Google's own verification reviewer, or none.
 *
 * Google's reviewer has to press Connect Google and see the consent screen, so
 * this account, unlike the one above, may hold a Google connection: the
 * reviewer's own test Google account. That is why it is a separate principal
 * with a code of its own (`GOOGLE_REVIEW_SIGNIN_CODE`), given only through
 * Google's private review form, and never the public App Store code: a code
 * anyone could read must not open an account holding Google tokens. A value
 * equal to any other fixed code turns it off rather than sharing one, and with
 * no valid code no provider exists, the same as the others.
 */
export const GOOGLE_REVIEW_EMAIL = "google-review@supa.media";
export const GOOGLE_REVIEW_PROVIDER_ID = "test-email-google-review";

export function googleReviewTestEmail(
  env: Environment = process.env,
): Array<{ email: string; code: string; id: string }> {
  const code = env.GOOGLE_REVIEW_SIGNIN_CODE?.trim() ?? "";
  if (code === "") return [];
  const others = [env.REVIEWER_SIGNIN_CODE, env.APP_REVIEW_SIGNIN_CODE, env.TEST_ACCOUNT_SIGNIN_CODE].map((other) => other?.trim());
  if (!/^\d{6}$/.test(code) || code === "000000" || others.includes(code)) {
    console.error("GOOGLE_REVIEW_SIGNIN_CODE is not a six-digit code of its own; the Google review sign-in is off.");
    return [];
  }
  return [{ email: GOOGLE_REVIEW_EMAIL, code, id: GOOGLE_REVIEW_PROVIDER_ID }];
}

async function emailOf(ctx: QueryCtx, userId: Id<"users">): Promise<string | undefined> {
  return (await ctx.db.get(userId))?.email?.trim().toLowerCase();
}

/**
 * Is this one of the accounts a fixed code opens for an outside reviewer: the
 * directory and App Store one, or Google's?
 *
 * Those codes are held by people outside the company, and the App Store
 * phone's was public in this repository's history (kept on purpose by the
 * owner, 2026-10-25). So both accounts are held to their own workspace: they
 * never join another workspace by invitation or email domain
 * (`invitations/join.ts`, `workspaceDomains.ts`), read nothing through a grant
 * or a share in a workspace they are not members of (`grants/outsider.ts`,
 * `shares/standing.ts`), and keep the one address that names them
 * (`signInEmails.ts`). A row naming one grants nothing rather than erroring,
 * the same answer as for a stranger.
 */
export async function isReservedReviewer(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  const email = await emailOf(ctx, userId);
  return email === REVIEWER_EMAIL || email === GOOGLE_REVIEW_EMAIL;
}

/**
 * May this account start a Google connection? Every account but the one the
 * directory and App Store codes open (`googleConnect/attempts.ts`). Google's
 * reviewer may: that is what its review is of.
 */
export async function mayHoldGoogleConnection(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  return (await emailOf(ctx, userId)) !== REVIEWER_EMAIL;
}
