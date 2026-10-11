/**
 * The work behind the staff tree index panel (`treeAdmin.ts`), internal
 * because it reads each workspace's search database with this deployment's
 * credential. The logic is `lib/adminFns/treeIndexes.ts`.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalQuery } from "../_generated/server";
import {
  fillTreeIndexes as fill,
  treeIndexReport,
  treeTargetsHandler,
  type TreeTarget,
} from "./lib/adminFns/treeIndexes";
import { treeIndexReportValidator, treeTargetsValidator, type TreeIndexRow } from "./lib/adminFns/treeIndexValidators";

export const treeTargets = internalQuery({
  args: {},
  returns: treeTargetsValidator,
  handler: async (ctx): Promise<{ targets: TreeTarget[]; truncated: boolean }> => await treeTargetsHandler(ctx),
});

export const readTreeIndexes = internalAction({
  args: {},
  returns: treeIndexReportValidator,
  handler: async (ctx): Promise<{ rows: TreeIndexRow[]; truncated: boolean }> => {
    const found: { targets: TreeTarget[]; truncated: boolean } = await ctx.runQuery(
      internal.functions.treeAdminInternal.treeTargets,
      {},
    );
    return await treeIndexReport(ctx, found);
  },
});

export const fillTreeIndexes = internalAction({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({ started: v.number() }),
  handler: async (ctx, args): Promise<{ started: number }> => {
    const { targets }: { targets: TreeTarget[] } = await ctx.runQuery(internal.functions.treeAdminInternal.treeTargets, {});
    const chosen = args.workspaceId === undefined ? targets : targets.filter((target) => target.workspaceId === args.workspaceId);
    return { started: await fill(ctx, chosen) };
  },
});
