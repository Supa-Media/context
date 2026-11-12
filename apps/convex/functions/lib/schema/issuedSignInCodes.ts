import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The bookkeeping for a sign-in code staff issued (`functions/signInCodes.ts`).
 *
 * The code itself lives where every sign-in code does, in `authVerificationCodes`,
 * as a keyed hash. This row counts the wrong codes typed against it, so a code
 * that lives up to fourteen days can be guessed at only ten times in all, on
 * top of the ten an hour every address gets. One row per address: issuing a new
 * code replaces the old one, as it does in the library's table.
 */
export const issuedSignInCodeTables = {
  issuedSignInCodes: defineTable({
    /** The account's address, lowercased. */
    email: v.string(),
    /** The provider the code was issued under: a `test-email*` id, or `email` for a staging persona. */
    provider: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    /** Wrong codes typed for this address since this code was issued. */
    misses: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_expiresAt", ["expiresAt"]),
};
