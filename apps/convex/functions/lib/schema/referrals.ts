import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Friends letting friends in: referral invites, and what each person may send.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts`. Metadata only — an address, who typed it and when.
 *
 * Context is invite-only (`lib/waitlist.ts`). A referral is one more thing that
 * lets an address in, next to an admitted waitlist row and a workspace
 * invitation: a person who is in may name up to three addresses, and each one
 * skips the waitlist for 14 days (Dev2, 2026-09-29). The rules are
 * `lib/referrals.ts`; this file is only what they read.
 *
 * ## What is stored and what is derived
 *
 * Only what somebody *did* is stored: sent, cancelled, revoked. "Joined" and
 * "expired" are read, not written — an invite has been used when an account
 * for its address was created while it was live, and it has expired when its
 * `expiresAt` has passed. A stored copy of either would be a second answer to
 * the same question, and nothing needs a sweep to keep it true.
 */
export const referralTables = {
  referralInvites: defineTable({
    inviterUserId: v.id("users"),
    /** Lowercased and trimmed — `waitlistEmail`. */
    email: v.string(),
    /**
     * Addresses the invite in the emailed link (`/join/<token>`), so the page
     * can say who invited you. **Not a credential**: what lets somebody in is
     * the address they type and the code mailed to it, so a forwarded link
     * does nothing for anybody else. Unguessable only so a stranger cannot
     * walk the table for inviters' handles.
     */
    token: v.string(),
    /**
     * `pending` until somebody acts on it. `cancelled` is the inviter taking it
     * back (the invite is returned to them); `revoked` is staff stopping it
     * (it stays used). Joined and expired are derived — see the file header.
     */
    status: v.union(v.literal("pending"), v.literal("cancelled"), v.literal("revoked")),
    createdAt: v.number(),
    expiresAt: v.number(),
    cancelledAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    revokedBy: v.optional(v.id("users")),
  })
    .index("by_email", ["email"])
    .index("by_inviter", ["inviterUserId", "createdAt"])
    .index("by_token", ["token"])
    .index("by_createdAt", ["createdAt"]),

  /** Invites staff gave on top of the base three. No row means none. */
  referralAllowances: defineTable({
    userId: v.id("users"),
    extra: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  /**
   * The deployment's referral switches. At most one row; none means invites
   * on and no community link.
   */
  referralSettings: defineTable({
    invitesOff: v.boolean(),
    /** The community's join link (a Discord invite). Shown only to people who are in. */
    communityUrl: v.optional(v.string()),
    updatedAt: v.number(),
    updatedBy: v.optional(v.id("users")),
  }),
};
