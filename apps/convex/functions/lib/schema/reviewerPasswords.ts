import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * A password staff set for a review account (`functions/reviewerPasswords.ts`,
 * `lib/reviewerPassword.ts`). Only its keyed hash is kept. One row per
 * address: setting a new one replaces it.
 */
export const reviewerPasswordTables = {
  reviewerPasswords: defineTable({
    /** The account's address, lowercased. */
    email: v.string(),
    userId: v.id("users"),
    salt: v.string(),
    /** HMAC-SHA256 of address, salt and password under the deployment's code key. */
    hash: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    /** Wrong passwords typed in the hour that began at `missWindowStart`. */
    misses: v.number(),
    missWindowStart: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_expiresAt", ["expiresAt"]),
};
