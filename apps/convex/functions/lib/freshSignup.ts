/**
 * The grace after a sign-up, for adding a personal email (signInEmails.ts).
 *
 * Adding an address to an account that already has one needs a code mailed
 * to a confirmed address (`emailProof.ts`). A person who has just signed up
 * with a work address is setting up their own, and has nothing else to prove
 * with yet, so for this long after the account was made, one confirmed
 * address may add another without proof. Once the account holds two, or
 * the window has passed, it is an ordinary account again.
 *
 * Pure: the caller reads the account and its addresses, and passes the counts.
 */

export const FRESH_SIGNUP_WINDOW_MS = 30 * 60 * 1000;

export function isFreshSingleEmailAccount(input: {
  /** `users._creationTime`. */
  createdAt: number;
  now: number;
  /** Every confirmed address on the account: the sign-in one and any attached. */
  confirmedCount: number;
  /** Attached sign-in emails only. Zero means the one confirmed address is the sign-in one. */
  attachedCount: number;
}): boolean {
  if (input.now - input.createdAt > FRESH_SIGNUP_WINDOW_MS) return false;
  return input.confirmedCount === 1 && input.attachedCount === 0;
}
