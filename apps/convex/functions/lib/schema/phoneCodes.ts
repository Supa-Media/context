import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Sign-in codes Context texts itself (`functions/phoneCodes.ts`).
 *
 * One row per phone, for the code last texted to it: a hash, never the code,
 * so a read of this table cannot sign anybody in. A row lives ten minutes, is
 * gone the moment its code is used, and allows five wrong tries.
 */
export const phoneCodeTables = {
  phoneCodes: defineTable({
    /** E.164. */
    phone: v.string(),
    /** SHA-256 of `<phone>:<code>`, hex. */
    codeHash: v.string(),
    expiresAt: v.number(),
    /** Wrong codes typed against this one. */
    attempts: v.number(),
  })
    .index("by_phone", ["phone"])
    .index("by_expiresAt", ["expiresAt"]),
};
