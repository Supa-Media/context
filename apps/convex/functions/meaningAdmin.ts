/**
 * The staff console's search-by-meaning panel: every workspace's index, and
 * Restart. Split out of `admin.ts` for size, under that file's rule: each
 * public function authorizes with `requireAdmin` inline, in its own handler.
 * The logic is `lib/adminFns/meaningIndexes.ts`.
 */

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireAdmin } from "./lib/admin";
import { recordAdminAudit } from "./lib/adminFns/audit";
import { toConvexError } from "./lib/adminFns/errors";
import {
  meaningIndexReportHandler,
  meaningIndexReportValidator,
  restartMeaningIndex,
  restartStuckMeaningIndexes,
} from "./lib/adminFns/meaningIndexes";

/**
 * The Search tab's indexing panel: every workspace's search-by-meaning row,
 * our own error code and cause, and counts. See `lib/adminFns/meaningIndexes.ts`.
 */
export const meaningIndexReport = query({
  args: {},
  returns: meaningIndexReportValidator,
  handler: async (ctx) => {
    await requireAdmin(ctx).catch((error: unknown) => {
      throw toConvexError(error);
    });
    return await meaningIndexReportHandler(ctx);
  },
});

/**
 * Start search-by-meaning indexing again: one workspace, or every one that is
 * failed or still filling when `workspaceId` is left out. Never turns on a
 * workspace whose owner turned it off.
 */
export const restartMeaningIndexing = mutation({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({ restarted: v.number(), outcome: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    let actor;
    try {
      actor = await requireAdmin(ctx);
    } catch (error) {
      throw toConvexError(error);
    }
    if (args.workspaceId !== undefined) {
      const outcome = await restartMeaningIndex(ctx, args.workspaceId);
      await recordAdminAudit(ctx, actor, "search.meaning_restarted", args.workspaceId, { outcome });
      return { restarted: outcome === "restarted" ? 1 : 0, outcome };
    }
    const { restarted } = await restartStuckMeaningIndexes(ctx);
    await recordAdminAudit(ctx, actor, "search.meaning_restarted", "*", { restarted });
    return { restarted };
  },
});
