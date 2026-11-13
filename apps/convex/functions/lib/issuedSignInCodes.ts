import type { MutationCtx } from "../../_generated/server";
import { isIsolatedStaging } from "./otpBypass";
import { DIRECTORY_REVIEW_EMAIL, DIRECTORY_REVIEW_PROVIDER_ID, GOOGLE_REVIEW_EMAIL, GOOGLE_REVIEW_PROVIDER_ID, REVIEWER_EMAIL, REVIEWER_PROVIDER_ID } from "./reviewerAccount";
import { TEST_ACCOUNT_EMAIL } from "./testAccount";

/**
 * Who may be issued a sign-in code, and the rules every issued code follows.
 *
 * Some accounts cannot read the mailbox a code would go to: the CUJ account's
 * automated runs, the App Store, directory and Google reviewers, and staging's
 * fictional personas. They used to sign in with fixed codes. Now staff issue
 * one code at a time (`functions/signInCodes.ts`), and that code is held to
 * the same controls as a customer's: random, single-use, expiring, and
 * attempt-limited (CASA 1.2.1, 1.3.1, 1.3.2, 1.3.4; 2026-11-11).
 */

/** The accounts on every deployment, each with the provider that refuses every other address. */
export const ISSUED_CODE_ACCOUNTS: ReadonlyArray<{ email: string; provider: string }> = [
  { email: TEST_ACCOUNT_EMAIL, provider: "test-email" },
  { email: REVIEWER_EMAIL, provider: REVIEWER_PROVIDER_ID },
  { email: DIRECTORY_REVIEW_EMAIL, provider: DIRECTORY_REVIEW_PROVIDER_ID },
  { email: GOOGLE_REVIEW_EMAIL, provider: GOOGLE_REVIEW_PROVIDER_ID },
];

/** Staging's fictional personas: the ordinary provider, and only on the isolated staging deployment. */
export const STAGING_PERSONAS: ReadonlyArray<string> = ["alpha", "beta", "gamma", "delta", "epsilon"].map(
  (name) => `${name}@supa.media`,
);

/** Every issued verifier has the same ten-minute lifetime as a customer's code (CASA 1.3.1). */
export const ISSUED_CODE_LIFETIME_MS = 10 * 60 * 1000;
/** Wrong codes in all against one issued code, on top of the ten an hour per address. */
export const MAX_ISSUED_CODE_MISSES = 10;

export type IssueTarget = { email: string; provider: string; lifetimeMs: number };

/**
 * The account `email` names and how long its code may live, or a refusal.
 * A persona is refused anywhere but the isolated staging deployment.
 */
export function issueTarget(
  email: string,
  env: Record<string, string | undefined> = process.env,
): IssueTarget | { refused: string } {
  const address = email.trim().toLowerCase();
  const account = ISSUED_CODE_ACCOUNTS.find((entry) => entry.email === address);
  if (account !== undefined) {
    return { email: address, provider: account.provider, lifetimeMs: ISSUED_CODE_LIFETIME_MS };
  }
  if (STAGING_PERSONAS.includes(address)) {
    if (!isIsolatedStaging(env)) return { refused: "staging personas are issued codes only on staging" };
    return { email: address, provider: "email", lifetimeMs: ISSUED_CODE_LIFETIME_MS };
  }
  return { refused: "codes are issued only for the CUJ, reviewer and staging persona accounts" };
}

/** Six random digits, every one equally likely. */
export function newIssuedCode(): string {
  const buffer = new Uint32Array(1);
  // Rejection sampling: 4,294,000,000 is the largest multiple of 1,000,000 under 2^32.
  do crypto.getRandomValues(buffer);
  while (buffer[0]! >= 4_294_000_000);
  return String(buffer[0]! % 1_000_000).padStart(6, "0");
}

/**
 * What the library is handed for `digits`: an issued-code provider's digits
 * bound to the provider and address, exactly as the auth patch binds what is
 * typed (`patches/@convex-dev__auth.patch`). The ordinary provider's are as typed.
 */
export function storedCodeFor(target: { email: string; provider: string }, digits: string): string {
  return target.provider === "email" ? digits : `${target.provider}:${target.email}:${digits}`;
}

/** Start counting misses afresh for a newly issued code. */
export async function recordIssued(
  ctx: MutationCtx,
  target: { email: string; provider: string },
  expiresAt: number,
): Promise<void> {
  for (const row of await ctx.db.query("issuedSignInCodes").withIndex("by_email", (q) => q.eq("email", target.email)).take(10)) {
    await ctx.db.delete(row._id);
  }
  await ctx.db.insert("issuedSignInCodes", { email: target.email, provider: target.provider, issuedAt: Date.now(), expiresAt, misses: 0 });
  for (const stale of await ctx.db
    .query("issuedSignInCodes")
    .withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now()))
    .take(20)) {
    await ctx.db.delete(stale._id);
  }
}

/** Delete the outstanding code(s) of the account `provider` holds for `email`. */
async function dropCodes(ctx: MutationCtx, provider: string, email: string): Promise<void> {
  const account = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) => q.eq("provider", provider).eq("providerAccountId", email))
    .unique();
  if (account === null) return;
  for (const code of await ctx.db
    .query("authVerificationCodes")
    .withIndex("accountId", (q) => q.eq("accountId", account._id))
    .take(10)) {
    await ctx.db.delete(code._id);
  }
}

type VerifyCall = { type?: unknown; provider?: unknown; params?: { email?: unknown } };

/**
 * Bound a verifier by its original issue time before the library can accept it.
 * Older deployments issued codes for days. Changing only issuance would leave
 * those rows usable for days after this deploy. Expire them at ten minutes too,
 * deleting both rows in this same transaction. An issued-code provider also
 * refuses an orphan code: without its lifecycle row, its age is not known.
 */
export async function beforeVerification(ctx: MutationCtx, call: VerifyCall): Promise<boolean> {
  if (call?.type !== "verifyCodeAndSignIn" || typeof call.params?.email !== "string") return true;
  const email = call.params.email.trim().toLowerCase();
  const row = await ctx.db.query("issuedSignInCodes").withIndex("by_email", (q) => q.eq("email", email)).first();
  if (row === null) {
    const account = ISSUED_CODE_ACCOUNTS.find((entry) => entry.email === email && entry.provider === call.provider);
    if (account === undefined) return true;
    await dropCodes(ctx, account.provider, email);
    return false;
  }
  if (row.provider !== call.provider) return true;
  if (Math.min(row.expiresAt, row.issuedAt + ISSUED_CODE_LIFETIME_MS) > Date.now()) return true;
  await dropCodes(ctx, row.provider, email);
  await ctx.db.delete(row._id);
  return false;
}

/**
 * After the library has answered a verification: a right code ends the
 * issued code's bookkeeping, and the tenth wrong one deletes the code.
 *
 * Only for addresses that hold an issued code. Called by `auth:store`
 * (`lib/emailCodeSends.ts`) in the same transaction as the library's own
 * attempt counting, so the two cannot disagree.
 */
export async function afterVerification(ctx: MutationCtx, call: VerifyCall, result: unknown): Promise<void> {
  if (call?.type !== "verifyCodeAndSignIn" || typeof call.params?.email !== "string") return;
  const email = call.params.email.trim().toLowerCase();
  const row = await ctx.db.query("issuedSignInCodes").withIndex("by_email", (q) => q.eq("email", email)).first();
  if (row === null || row.provider !== call.provider) return;
  if (result !== null) {
    await ctx.db.delete(row._id);
    return;
  }
  const misses = row.misses + 1;
  if (misses >= MAX_ISSUED_CODE_MISSES) {
    await dropCodes(ctx, row.provider, email);
    await ctx.db.delete(row._id);
    return;
  }
  await ctx.db.patch(row._id, { misses });
}
