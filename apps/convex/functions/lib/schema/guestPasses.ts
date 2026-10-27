import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Opening a note by phone, for the people in a Tex guest chat who have no account (`functions/guestPass.ts`,
 * decided by the owner, 2026-10-27; `docs/decisions/texting-assistant/guest-phone-pass.md`).
 *
 * Neither table holds a phone number. A number is kept only as a keyed hash (`lib/guestPhones.ts`), and the key
 * lives in the deployment's environment, so the hashes can't be walked back to numbers from these rows alone.
 */
export const guestPassTables = {
  /**
   * Who is in each guest chat, as hashes: rewritten from the participants every time the chat is tagged, and
   * emptied when guest mode goes off. A number here may be texted a code to open what the chat's group can see.
   */
  chatGuestPhones: defineTable({
    chatId: v.id("textGroups"),
    workspaceId: v.id("workspaces"),
    phoneHash: v.string(),
    seenAt: v.number(),
  })
    .index("by_phone_hash", ["phoneHash"])
    .index("by_chat", ["chatId"]),
  /**
   * A browser that proved a number with a texted code. The pass itself stays on that browser; only its hash is
   * here. It names a number, not a chat: what it opens is worked out again on every read.
   */
  guestPasses: defineTable({
    tokenHash: v.string(),
    phoneHash: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_token", ["tokenHash"])
    .index("by_phone_hash", ["phoneHash"])
    .index("by_expiresAt", ["expiresAt"]),
};
