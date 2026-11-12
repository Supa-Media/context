/**
 * How a one-time code is kept: a keyed hash, never a plain digest.
 *
 * Context's short codes (six digits texted or mailed, ten digits a link
 * mints) used to be stored as SHA-256 of the code. A million six-digit codes
 * hash in well under a second, so a copy of any of those tables gave every
 * live code back (CASA 1.1.3, 2026-11-11).
 *
 * Each is now an HMAC-SHA256 under a key that lives only in the deployment's
 * environment, never in the database: `AUTH_CODE_HASH_KEY` when set,
 * otherwise the auth signing key (`JWT_PRIVATE_KEY`) every deployment already
 * has. A leaked table without the environment recovers nothing; with the
 * environment the signing key is already lost, which mints sessions outright.
 *
 * Why not Argon2id, bcrypt, scrypt or PBKDF2: an adaptive hash slows each
 * guess, but there are only a million guesses. Even at 100 ms each, a laptop
 * recovers a six-digit code from its hash in under a day, and a GPU in
 * minutes, well inside a code that lives ten minutes to fourteen days. The
 * secret key is what makes the stored value useless on its own. The lookups
 * also need the hash to be deterministic (the library finds a sign-in code by
 * it through an index), which a per-row salt would rule out.
 *
 * Every code store uses a `purpose` of its own, so a value from one table
 * never matches in another. The `@convex-dev/auth` patch computes the same
 * scheme for its own table under the purpose `convex-auth`
 * (`patches/@convex-dev__auth.patch`, `hashVerificationCode`), and
 * `__tests__/oneTimeCodes.test.ts` holds the two to one answer.
 */

export const CODE_HASH_KEY_ENV = "AUTH_CODE_HASH_KEY";

/** The purposes in use. A new store adds its own rather than borrowing one. */
export type OneTimeCodePurpose =
  | "convex-auth"
  | "phone-sign-in"
  | "text-sign-in"
  | "text-link"
  | "email-proof"
  | "sign-in-email"
  | "email-recovery";

type Environment = Record<string, string | undefined>;

function keyMaterial(env: Environment): string {
  const material = env[CODE_HASH_KEY_ENV]?.trim() || env.JWT_PRIVATE_KEY?.trim();
  if (!material) {
    // Refuse rather than fall back to a plain digest: a code that cannot be
    // stored safely is not issued at all.
    throw new Error("One-time codes need AUTH_CODE_HASH_KEY or JWT_PRIVATE_KEY on the deployment.");
  }
  return material;
}

/** The value stored for `code`, hex. Same inputs, same answer, so it can be looked up. */
export async function hashOneTimeCode(
  purpose: OneTimeCodePurpose,
  code: string,
  env: Environment = process.env,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(keyMaterial(env)) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`context-one-time-code:v1:${purpose}:${code}`) as BufferSource,
  );
  return Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
