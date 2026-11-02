import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The staff console's second factor (`functions/staffSecondFactor.ts`): an
 * authenticator app's six-digit code on top of the email code that signs a
 * person in. Metadata only: the authenticator key is never stored, it is
 * derived from the deployment's storage key and the row's `nonce`.
 */
export const staffSecondFactorTables = {
  /**
   * One per staff account. Pending until `confirmedAt`: a key is only
   * enforced once its holder has typed a code from it, and only the session
   * that started a pending key is shown it.
   */
  staffSecondFactors: defineTable({
    userId: v.id("users"),
    nonce: v.string(),
    startedBySession: v.id("authSessions"),
    confirmedAt: v.optional(v.number()),
    /**
     * A replacement key being set up by an enrolled account. The confirmed
     * key above stays in force until a code from this one is typed by the
     * session that started it, so swapping keys never opens a gap.
     */
    pending: v.optional(v.object({ nonce: v.string(), startedBySession: v.id("authSessions") })),
    /** The newest time step a code was taken at; a code is never taken twice. */
    lastUsedStep: v.number(),
    wrongTries: v.number(),
    triesWindowStartedAt: v.number(),
  }).index("by_user", ["userId"]),

  /** A session that typed a code: staff pages open for it until `until`. */
  staffStepUps: defineTable({
    userId: v.id("users"),
    sessionId: v.id("authSessions"),
    until: v.number(),
  }).index("by_session", ["sessionId"]),
};
