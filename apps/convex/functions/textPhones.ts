import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { isPhoneNumber } from "./textLinks";

/** More than Tex will have for a long while; a cap so one read stays bounded. */
const MAX_PHONES = 5_000;

/**
 * Every phone Tex may have a chat with: those linked to an account, and
 * those let in off the waitlist by number. Read only by the Worker's
 * new-number notice (`apps/agent/src/newLine.ts`), which texts a phone only
 * where that phone itself started a chat. Phones, never anything else.
 */
export const knownPhones = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const phones = new Set<string>();
    for (const row of await ctx.db.query("phoneLinks").take(MAX_PHONES)) phones.add(row.phone);
    const admitted = ctx.db
      .query("waitlist")
      .withIndex("by_status_joinedAt", (q) => q.eq("status", "admitted"));
    for await (const row of admitted) {
      if (phones.size >= MAX_PHONES) break;
      if (row.phone !== undefined) phones.add(row.phone);
    }
    return [...phones].filter(isPhoneNumber).sort().slice(0, MAX_PHONES);
  },
});
