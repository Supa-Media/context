import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Account safety: your phone opens Context, your email guards it (Dev2,
 * 2026-10-12, boards k1-k4).
 *
 * A texted code signs a person in, so a SIM swap would otherwise be a full
 * takeover. The changes that could lock a person out or take their notes away
 * also need a code mailed to one of their confirmed emails
 * (`lib/emailProof.ts`). These tables hold that proof and the pieces around
 * it. Metadata only: never a code (hashes), never note content.
 */
export const emailProofTables = {
  /**
   * A code mailed to one of the person's own emails, for the session that
   * asked. Only its hash is kept; ten minutes, five wrong tries, one live code
   * per session.
   */
  emailProofCodes: defineTable({
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    email: v.string(),
    hashedCode: v.string(),
    expiresAt: v.number(),
    wrongTries: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_user", ["userId"]),

  /**
   * A session that typed a mailed code back. It may make big changes until
   * `until` (fifteen minutes). Bound to the session, so another device signed
   * in with only the phone gets nothing from it.
   */
  emailProofs: defineTable({
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    until: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_user", ["userId"]),

  /**
   * A sign-in by phone, told to every email on the account. The email's
   * "This wasn't me" link carries a token whose hash is kept here; using it
   * signs every session out and pauses phone sign-in (`users` row, see
   * `lib/emailProof.ts`). Kept seven days.
   */
  signInAlerts: defineTable({
    userId: v.id("users"),
    hashedToken: v.string(),
    at: v.number(),
    /** Last four digits of the phone the code was texted to. */
    phoneLast4: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_token", ["hashedToken"])
    .index("by_user", ["userId"])
    .index("by_expiresAt", ["expiresAt"]),

  /**
   * Phone sign-in paused by "This wasn't me". While a row exists, the phone
   * signs nobody in and the texting assistant does not answer it; signing in
   * by email and confirming with an emailed code lifts it.
   */
  phoneSignInPauses: defineTable({
    userId: v.id("users"),
    pausedAt: v.number(),
  }).index("by_user", ["userId"]),

  /**
   * Adding an email when none of the person's emails can confirm it (board
   * k4): it waits seven days, every current email is told and can cancel it.
   * The new address was itself confirmed by a code before the wait started.
   */
  emailRecoveries: defineTable({
    userId: v.id("users"),
    email: v.string(),
    startedAt: v.number(),
    finishesAt: v.number(),
    /** Hash of the token in the "Cancel" link mailed to the current emails. */
    hashedCancelToken: v.string(),
    status: v.union(v.literal("waiting"), v.literal("done"), v.literal("cancelled")),
    remindedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_cancel_token", ["hashedCancelToken"])
    .index("by_status_finishesAt", ["status", "finishesAt"]),

  /** A code mailed to the new address before a recovery wait starts. */
  emailRecoveryCodes: defineTable({
    userId: v.id("users"),
    email: v.string(),
    hashedCode: v.string(),
    expiresAt: v.number(),
    wrongTries: v.number(),
  }).index("by_user", ["userId"]),
};
