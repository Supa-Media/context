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
 * Is this account the reserved reviewer — the one the directory code and the
 * App Store review phone open?
 *
 * Those sign-ins are fixed codes held by people outside the company, and the
 * phone's code was public in this repository's history (kept on purpose by the
 * owner, 2026-10-25). So the account they open is held to its own workspace:
 * it never starts a Google connection (`googleConnect/attempts.ts`), never
 * joins another workspace by invitation or email domain
 * (`invitations/join.ts`, `workspaceDomains.ts`), and reads nothing through a
 * grant in a workspace it is not a member of (`grants/outsider.ts`). A row
 * naming it grants nothing rather than erroring, the same answer as for a
 * stranger.
 */
export async function isReservedReviewer(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  const user = await ctx.db.get(userId);
  return user?.email?.trim().toLowerCase() === REVIEWER_EMAIL;
}
