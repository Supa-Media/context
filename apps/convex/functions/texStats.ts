/**
 * tex.lc/admin's basics for any window: people, texts in and out, inference
 * cost, notes created and edited. An action, because it asks Cloudflare; the
 * staff check is the internal query every admin action uses. The logic is
 * `lib/adminFns/texStats.ts`.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { toConvexError } from "./lib/adminFns/errors";
import { clampStatsWindow, texStats, texStatsValidator, type TexStats } from "./lib/adminFns/texStats";

export const report = action({
  args: { from: v.optional(v.number()), to: v.optional(v.number()) },
  returns: texStatsValidator,
  handler: async (ctx, args): Promise<TexStats> => {
    try {
      await ctx.runQuery(internal.functions.admin.requireAdminActor, {});
    } catch (error) {
      throw toConvexError(error);
    }
    return await texStats(
      {
        CLOUDFLARE_ANALYTICS_TOKEN: process.env.CLOUDFLARE_ANALYTICS_TOKEN,
        CLOUDFLARE_ANALYTICS_ACCOUNT_ID: process.env.CLOUDFLARE_ANALYTICS_ACCOUNT_ID,
        APP_ENV: process.env.APP_ENV,
      },
      clampStatsWindow(args.from, args.to, Date.now()),
    );
  },
});
