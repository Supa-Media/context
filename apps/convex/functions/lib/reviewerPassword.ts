import { hashOneTimeCode } from "./oneTimeCodes";

/**
 * The review accounts that sign in with a password staff set: YC's, and
 * Google's OAuth verification reviewer's (owner, 2026-11-14; Google's approved
 * by Seyi, 2026-11-18).
 *
 * YC's partners review an application whenever they get to it, so neither a
 * code mailed to an inbox they cannot read nor an issued code that lives ten
 * minutes (`issuedSignInCodes.ts`) lets them in. Google's reviewer works on
 * Google's schedule for the same reason: a ten-minute issued code cannot sit
 * in Google's review form. Both accounts sign in with a password under the
 * same controls CASA holds a code to (1.2.1, 1.3.x, 2.x; the fixed codes
 * failed it on 2026-11-11):
 *
 *  - Staff set it (`functions/reviewerPasswords.ts`, run only with the deploy
 *    key). It is 20 random letters and digits, about 117 bits, never chosen by
 *    a person, never in the repository or an Actions log: it is mailed to the
 *    team inbox only.
 *  - It is stored as a keyed hash with a per-password salt
 *    (`oneTimeCodes.ts`, purpose `reviewer-password`). A copy of the table
 *    without the deployment's environment recovers nothing; an adaptive hash
 *    would add nothing against 117 random bits.
 *  - It expires after 30 days, setting a new one replaces it, and revoking
 *    deletes it. After ten wrong passwords in an hour it refuses everyone,
 *    the right password included, until that hour is up (CASA 2.2.1). It is
 *    not deleted by wrong guesses: the address is public, so a stranger could
 *    otherwise end the reviewer's access at will. The worst a stranger can do
 *    is hold it shut an hour at a time, and the workflow says so.
 *  - It opens only its own account. Each account is held to its own workspace
 *    like the other reviewer accounts (`reviewerAccount.ts`,
 *    `isReservedReviewer`). Google's may still connect Google
 *    (`mayHoldGoogleConnection`), because that is what its review is of.
 *  - Google's account's issued-code provider is retired, so no second path
 *    opens it.
 *
 * The addresses are public, because the sign-in screen routes them to a
 * password box. They hold no privilege.
 */

export const YC_REVIEW_EMAIL = "yc-review@supa.media";
export const GOOGLE_REVIEW_EMAIL = "google-review@supa.media";
export const REVIEWER_PASSWORD_PROVIDER_ID = "reviewer-password";

/** The accounts a staff-set password may open. Every other address is refused before anything is read. */
export const PASSWORD_ACCOUNTS: ReadonlyArray<string> = [YC_REVIEW_EMAIL, GOOGLE_REVIEW_EMAIL];

export const REVIEWER_PASSWORD_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_REVIEWER_PASSWORD_MISSES = 10;
export const REVIEWER_PASSWORD_MISS_WINDOW_MS = 60 * 60 * 1000;
export const REVIEWER_PASSWORD_LENGTH = 20;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** The address if a staff-set password may open it, else `null`. */
export function passwordAccount(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return PASSWORD_ACCOUNTS.includes(email) ? email : null;
}

/** Random characters from an unambiguous alphabet, every one equally likely. */
function randomString(length: number): string {
  // Rejection sampling: the largest multiple of the alphabet's size under 256.
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  const buffer = new Uint8Array(1);
  while (out.length < length) {
    crypto.getRandomValues(buffer);
    if (buffer[0]! < limit) out += ALPHABET[buffer[0]! % ALPHABET.length];
  }
  return out;
}

/** A new password: 20 characters from a 57-character alphabet, about 117 bits. */
export function newReviewerPassword(): string {
  return randomString(REVIEWER_PASSWORD_LENGTH);
}

export function newSalt(): string {
  return randomString(24);
}

/** The value stored for `password` under `salt`, bound to the account. */
export async function hashReviewerPassword(email: string, salt: string, password: string): Promise<string> {
  return await hashOneTimeCode("reviewer-password", `${email}:${salt}:${password}`);
}

/** Equal-length hex compared without an early exit. */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
