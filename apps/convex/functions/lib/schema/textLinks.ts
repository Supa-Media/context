import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Which phone numbers may text the Context assistant, and as whom.
 *
 * Metadata only: a phone number, the account it belongs to and when. Never a
 * message. The number is the whole of a texter's identity, so a link is made
 * only by texting a code the signed-in app showed for that exact number, which
 * proves the person holds both the account and the phone.
 *
 * Deleted with the account (`personalRows.ts`). A link points at an account and
 * never at a workspace: the answer always comes from the account's own personal
 * workspace, resolved when the text arrives.
 */
export const textLinkTables = {
  phoneLinks: defineTable({
    userId: v.id("users"),
    /** E.164, e.g. +15555550100. */
    phone: v.string(),
    linkedAt: v.number(),
  })
    .index("by_phone", ["phone"])
    .index("by_user", ["userId"]),

  /**
   * A code the app showed, waiting to be texted from `phone`. Only its hash is
   * kept. Ten minutes, five wrong tries, then it is gone.
   */
  phoneLinkCodes: defineTable({
    userId: v.id("users"),
    phone: v.string(),
    hashedCode: v.string(),
    expiresAt: v.number(),
    wrongTries: v.number(),
  })
    .index("by_phone", ["phone"])
    .index("by_user", ["userId"]),

  /**
   * A link texted to an unlinked phone. Opening it signed in shows a code for
   * that phone, so nobody types their number; the code still has to be texted
   * back from the phone, so a forwarded link links nothing. Only the token's
   * hash is kept, for thirty minutes, one live link per phone.
   */
  phoneLinkInvites: defineTable({
    phone: v.string(),
    hashedToken: v.string(),
    expiresAt: v.number(),
  })
    .index("by_phone", ["phone"])
    .index("by_hashed_token", ["hashedToken"])
    .index("by_expires", ["expiresAt"]),
};
