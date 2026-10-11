/**
 * The staff console's tree index panel: every workspace's tree table, and
 * Fill. Each public function checks staff inline, as `admin.ts` requires, and
 * hands the work to `treeAdminInternal.ts`: reading a workspace's database
 * needs this deployment's Cloudflare credential, which no public function may
 * reach (`__tests__/structure/reachability.test.ts`).
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, type ActionCtx } from "../_generated/server";
import { toConvexError } from "./lib/adminFns/errors";
import { treeIndexReportValidator, type TreeIndexRow } from "./lib/adminFns/treeIndexValidators";

async function staffOnly(ctx: ActionCtx) {
  try {
    await ctx.runQuery(internal.functions.admin.requireAdminActor, {});
  } catch (error) {
    throw toConvexError(error);
  }
}

/** Every workspace's tree index: filled or not, how many keys, when last filled. */
export const treeIndexes = action({
  args: {},
  returns: treeIndexReportValidator,
  handler: async (ctx): Promise<{ rows: TreeIndexRow[]; truncated: boolean }> => {
    await staffOnly(ctx);
    return await ctx.runAction(internal.functions.treeAdminInternal.readTreeIndexes, {});
  },
});

/** Fill one workspace's tree index now, or every workspace's when `workspaceId` is left out. */
export const fillTreeIndexesNow = action({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({ started: v.number() }),
  handler: async (ctx, args): Promise<{ started: number }> => {
    await staffOnly(ctx);
    return await ctx.runAction(internal.functions.treeAdminInternal.fillTreeIndexes, args);
  },
});
