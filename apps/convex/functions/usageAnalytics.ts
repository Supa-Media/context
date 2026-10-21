/**
 * The staff console's Usage tab: visits to context.lc and tex.lc, time in the
 * app, and the most viewed pages and most pressed buttons, read from PostHog.
 * An action, because it asks PostHog; the staff check is the internal query
 * every admin action uses. The logic is `lib/adminFns/usageAnalytics.ts`.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { toConvexError } from "./lib/adminFns/errors";
import { usageAnalytics } from "./lib/adminFns/usageAnalytics";
import { usageAnalyticsValidator, type UsageAnalytics } from "./lib/adminFns/usageAnalyticsShape";

/** The console offers 7, 30 and 90; anything else is held to that range. */
export function clampUsageDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return 30;
  return Math.min(90, Math.max(1, Math.round(days)));
}

export const report = action({
  args: { days: v.optional(v.number()) },
  returns: usageAnalyticsValidator,
  handler: async (ctx, args): Promise<UsageAnalytics> => {
    try {
      await ctx.runQuery(internal.functions.admin.requireAdminActor, {});
    } catch (error) {
      throw toConvexError(error);
    }
    return await usageAnalytics(
      {
        POSTHOG_PERSONAL_API_KEY: process.env.POSTHOG_PERSONAL_API_KEY,
        POSTHOG_PROJECT_ID: process.env.POSTHOG_PROJECT_ID,
      },
      clampUsageDays(args.days),
    );
  },
});
