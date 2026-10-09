import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Extra emails a person signs in with (Dev2, 2026-10-09: one account per
 * person, several sign-in emails).
 *
 * The address mail goes to stays on `users.email`; these are the others. Each
 * row was confirmed with a code mailed to it, so it is as much an identifier
 * as the main address: `lib/identities.ts` resolves shares and invitations
 * addressed to it to this person, and `auth.ts` signs a sign-in through it
 * into this account (`findUserByEmail`). An address is on at most one
 * account, counting `users.email` too.
 */
export const signInEmailTables = {
  signInEmails: defineTable({
    userId: v.id("users"),
    /** Lower case and trimmed. */
    email: v.string(),
    addedAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_user", ["userId"]),

  /**
   * A code mailed to an address someone is adding. Only its hash is kept; ten
   * minutes and five wrong tries, one live code per person.
   */
  signInEmailCodes: defineTable({
    userId: v.id("users"),
    email: v.string(),
    hashedCode: v.string(),
    expiresAt: v.number(),
    wrongTries: v.number(),
  }).index("by_user", ["userId"]),

  /**
   * Retired with "Do you already use Context with another email?" (board s7)
   * when sign-in moved to phone numbers (2026-10-09): a phone now ties a new
   * address to the person who already has an account. Nothing writes here any
   * more; the table stays declared until its fifteen-minute rows are gone and
   * it can be dropped without a deploy refusing the schema.
   */
  emailHandOffs: defineTable({
    fromUserId: v.id("users"),
    hashedToken: v.string(),
    expiresAt: v.number(),
  })
    .index("by_token", ["hashedToken"])
    .index("by_user", ["fromUserId"]),
};
