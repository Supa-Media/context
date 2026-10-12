/**
 * The work behind the staff tree index panel (`treeAdmin.ts`), internal
 * because it reads each workspace's search database with this deployment's
 * credential. The logic is `lib/adminFns/treeIndexes.ts`.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, internalAction, internalQuery } from "../_generated/server";
import {
  fillTreeIndexes as fill,
  treeIndexReport,
  treeTargetsHandler,
  type TreeTarget,
} from "./lib/adminFns/treeIndexes";
import {
  convexTreeValidator,
  treeIndexReportValidator,
  treeTargetsValidator,
  type TreeIndexRow,
} from "./lib/adminFns/treeIndexValidators";

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

/** The Convex tree's bookkeeping for one workspace: counts, times and the last parity check. Never a path. */
export const convexTreeOf = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(convexTreeValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("nodeTrees")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (row === null) return null;
    return { status: row.status, files: row.files, sweptAt: row.sweptAt ?? null, parity: row.parity ?? null };
  },
});

/** The workspaces one fill or parity check is for: one, or all of the report's. */
async function chosenTargets(ctx: ActionCtx, workspaceId: Id<"workspaces"> | undefined): Promise<TreeTarget[]> {
  const { targets }: { targets: TreeTarget[] } = await ctx.runQuery(internal.functions.treeAdminInternal.treeTargets, {});
  return workspaceId === undefined ? targets : targets.filter((target) => target.workspaceId === workspaceId);
}

export const fillTreeIndexes = internalAction({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({ started: v.number() }),
  handler: async (ctx, args): Promise<{ started: number }> => {
    const chosen = await chosenTargets(ctx, args.workspaceId);
    // The Convex tree (`lib/nodes/`) is filled by the same button: a sweep per workspace.
    for (const target of chosen) {
      await ctx.scheduler
        .runAfter(0, internal.functions.files.runFileOperation, {
          workspaceId: target.workspaceId,
          scope: "private",
          operation: { kind: "nodesSweep" },
        })
        .catch(() => {});
    }
    return { started: await fill(ctx, chosen) };
  },
});

/** Check the Convex tree against the bucket now, for one workspace or every one with a search database. */
export const checkNodesParity = internalAction({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({ started: v.number() }),
  handler: async (ctx, args): Promise<{ started: number }> => {
    const chosen = await chosenTargets(ctx, args.workspaceId);
    for (const target of chosen) {
      await ctx.scheduler
        .runAfter(0, internal.functions.files.runFileOperation, {
          workspaceId: target.workspaceId,
          scope: "private",
          operation: { kind: "nodesParity" },
        })
        .catch(() => {});
    }
    return { started: chosen.length };
  },
});
