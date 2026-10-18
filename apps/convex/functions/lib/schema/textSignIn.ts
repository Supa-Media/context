import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Sign-in links Tex texts to a phone set up by text (`functions/textSignIn.ts`).
 *
 * Only hashes are kept: the link's token, and once the link is opened, the
 * short-lived code its page signs in with. So a read of this table signs
 * nobody in. A row is good for one opening, within `expiresAt`.
 */
export const textSignInTables = {
  textSignInLinks: defineTable({
    userId: v.id("users"),
    /** E.164: the phone the link was texted to, and the only one it signs in. */
    phone: v.string(),
    /** SHA-256 of the token in the link, hex. */
    tokenHash: v.string(),
    /** The app path the page goes to once signed in, built by us, never by the caller. */
    next: v.string(),
    expiresAt: v.number(),
    /** Set when the page opened the link; a link is opened once. */
    openedAt: v.optional(v.number()),
    /** SHA-256 of the code the opening minted, hex; gone once used. */
    codeHash: v.optional(v.string()),
    codeExpiresAt: v.optional(v.number()),
  })
    .index("by_token", ["tokenHash"])
    .index("by_phone", ["phone"])
    .index("by_expiresAt", ["expiresAt"]),
};
