import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Cloud transcription consent, one row per account
 * (`docs/decisions/meetings/transcription-consent.md`).
 *
 * The answer and the disclosure version it answered. A missing row is no; a
 * row whose `version` is not `CLOUD_TRANSCRIPTION_CONSENT_VERSION` is no; a
 * row with `withdrawnAt` is no. Only the person writes it, and every cloud
 * transcription boundary reads it before a byte of audio is forwarded.
 * Deleted with the account (`personalRows.ts`).
 */
export const transcriptionConsentTables = {
  transcriptionConsents: defineTable({
    userId: v.id("users"),
    /** The disclosure version the yes answered. */
    version: v.number(),
    /** The provider named in that disclosure, kept so the yes says what it was to. */
    provider: v.string(),
    grantedAt: v.number(),
    /** When they turned it off. Absent while it is on. */
    withdrawnAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
};
