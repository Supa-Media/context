/**
 * tex.lc/admin's spend, as Cloudflare's AI gateway priced it. An action,
 * because it asks Cloudflare; the staff check is the internal query every
 * admin action uses. The logic is `lib/adminFns/texSpend.ts`.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { toConvexError } from "./lib/adminFns/errors";
import { texSpend, texSpendValidator, type TexSpend } from "./lib/adminFns/texSpend";

/** The dashboard offers 7, 30 and 90; anything else is held to that range. */
export function clampTexSpendDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return 7;
  return Math.min(90, Math.max(1, Math.round(days)));
}

export const report = action({
  args: { days: v.optional(v.number()) },
  returns: texSpendValidator,
  handler: async (ctx, args): Promise<TexSpend> => {
    try {
      await ctx.runQuery(internal.functions.admin.requireAdminActor, {});
    } catch (error) {
      throw toConvexError(error);
    }
    return await texSpend(
      {
        CLOUDFLARE_ANALYTICS_TOKEN: process.env.CLOUDFLARE_ANALYTICS_TOKEN,
        CLOUDFLARE_ANALYTICS_ACCOUNT_ID: process.env.CLOUDFLARE_ANALYTICS_ACCOUNT_ID,
      },
      clampTexSpendDays(args.days),
    );
  },
});
