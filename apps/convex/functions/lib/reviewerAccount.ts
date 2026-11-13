import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

/**
 * The accounts outside reviewers sign in to: the Claude and ChatGPT directory
 * reviewers, Apple's App Store reviewer, and Google's verification reviewer.
 *
 * None of them can read our email, so none is mailed a code. Each has a
 * provider of its own that refuses every other address, and the only codes it
 * accepts are ones staff issue for one review (`functions/signInCodes.ts`):
 * random, single-use, expiring after ten minutes, ten wrong tries in all
 * and the same ten an hour under the address as every customer. Starting a
 * sign-in through one mints nothing (`patches/@convex-dev__auth.patch`).
 *
 * Until 2026-11-11 each took a fixed code from the deployment's environment
 * (`REVIEWER_SIGNIN_CODE` and the rest), and the App Store phone alias took a
 * code that was once public in this repository. A fixed code that works every
 * time for whoever read it is what CASA 1.2.1 and 1.3.1/1.3.2/1.3.4 failed;
 * those variables are read nowhere now.
 *
 * The addresses are public, because the sign-in screen has to route them to
 * their providers. They hold no privileges: `isProductionTestAccount` names
 * only the CUJ address.
 */

export const REVIEWER_EMAIL = "connector-review@supa.media";
export const REVIEWER_PROVIDER_ID = "test-email-reviewer";

export type IssuedCodeAccount = { email: string; id: string };

/** The directory and App Store reviewer's provider. Always registered; it opens only with an issued code. */
export function reviewerTestEmail(): IssuedCodeAccount[] {
  return [{ email: REVIEWER_EMAIL, id: REVIEWER_PROVIDER_ID }];
}

/** A fresh sample-only principal for directory review. */
export const DIRECTORY_REVIEW_EMAIL = "directory-review@supa.media";
export const DIRECTORY_REVIEW_PROVIDER_ID = "test-email-directory-review";
export function directoryReviewTestEmail(): IssuedCodeAccount[] {
  return [{ email: DIRECTORY_REVIEW_EMAIL, id: DIRECTORY_REVIEW_PROVIDER_ID }];
}

/**
 * The retired App Store review phone alias: a reserved fictional number that
 * once took a fixed code. It is texted nothing and signs nobody in
 * (`phoneSignIn.ts`), and stays reserved so no account can claim it
 * (`textSetup.ts`). Apple's reviewer signs in to `REVIEWER_EMAIL` with an
 * issued code instead.
 */
export const APP_REVIEW_PHONE = "+12025550123";

/**
 * Google's verification reviewer has to press Connect Google and see the
 * consent screen, so this account, unlike the one above, may hold a Google
 * connection: the reviewer's own test Google account. That is why it is a
 * separate principal, and why its codes are issued for it alone.
 */
export const GOOGLE_REVIEW_EMAIL = "google-review@supa.media";
export const GOOGLE_REVIEW_PROVIDER_ID = "test-email-google-review";

export function googleReviewTestEmail(): IssuedCodeAccount[] {
  return [{ email: GOOGLE_REVIEW_EMAIL, id: GOOGLE_REVIEW_PROVIDER_ID }];
}

async function emailOf(ctx: QueryCtx, userId: Id<"users">): Promise<string | undefined> {
  return (await ctx.db.get(userId))?.email?.trim().toLowerCase();
}

/**
 * Is this one of the accounts an outside reviewer signs in to: the directory
 * and App Store one, or Google's?
 *
 * Their codes are handed to people outside the company. So these accounts are
 * held to their own workspace: they
 * never join another workspace by invitation or email domain
 * (`invitations/join.ts`, `workspaceDomains.ts`), read nothing through a grant
 * or a share in a workspace they are not members of (`grants/outsider.ts`,
 * `shares/standing.ts`), and keep the one address that names them
 * (`signInEmails.ts`). A row naming one grants nothing rather than erroring,
 * the same answer as for a stranger.
 */
export async function isReservedReviewer(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  const email = await emailOf(ctx, userId);
  return email === REVIEWER_EMAIL || email === GOOGLE_REVIEW_EMAIL || email === DIRECTORY_REVIEW_EMAIL;
}

/**
 * May this account start a Google connection? Every account but the ones the
 * directory and App Store reviewers sign in to (`googleConnect/attempts.ts`). Google's
 * reviewer may: that is what its review is of.
 */
export async function mayHoldGoogleConnection(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  const email = await emailOf(ctx, userId);
  return email !== REVIEWER_EMAIL && email !== DIRECTORY_REVIEW_EMAIL;
}
