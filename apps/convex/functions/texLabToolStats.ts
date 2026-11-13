/**
 * The Tex Architecture Lab's tool stats (its Tools tab): staff only. The
 * report itself is `lib/adminFns/texToolStats.ts`.
 */

import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireAdmin } from "./lib/admin";
import { toConvexError } from "./lib/adminFns/errors";
import { toolStatsReport, toolStatsValidator } from "./lib/adminFns/texToolStats";

/** A window is one to thirty days, whole days; anything else is pulled into that range. */
export function clampDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return 7;
  return Math.min(30, Math.max(1, Math.floor(days)));
}

export const toolStats = query({
  args: { days: v.optional(v.number()) },
  returns: toolStatsValidator,
  handler: async (ctx, args) => {
    await requireAdmin(ctx).catch((error: unknown) => {
      throw toConvexError(error);
    });
    return await toolStatsReport(ctx, clampDays(args.days), Date.now());
  },
});
