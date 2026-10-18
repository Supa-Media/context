/**
 * Forgetting a workspace's tree: when the workspace is deleted, and when its
 * storage moves to a different bucket.
 *
 * The rows are names from one bucket (`lib/schema/nodes.ts`). A deleted
 * workspace's names have no reason to stay with us (the owner's decision of
 * 2026-10-12 put them here on that condition), and rows from the bucket a
 * workspace left describe somewhere its notes no longer are. Either way the
 * rows go, and a tree still in use is rebuilt by the next sweep.
 *
 * A large tree is more rows than one mutation may delete, so the first batch
 * goes with the caller's transaction and the rest are deleted by a chain of
 * scheduled batches. A sweep of the old bucket still in flight cannot keep
 * them: its next step finds no bookkeeping row and stops, and the next sweep
 * of the new bucket removes every row it did not see.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { isAuthority, privacyAuthorityOn, scheduleExport } from "./lib/nodes/privacyAuthority";
import { purgeSmallDataBatch, resetSmallDataForStorage } from "./lib/smallData/purge";

/** Rows one batch deletes. */
const PURGE_BATCH = 1_000;

/** Delete one batch of a workspace's tree rows; schedule the next while any remain. */
async function purgeBatch(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  const rows = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
    .take(PURGE_BATCH);
  for (const row of rows) await ctx.db.delete(row._id);
  // The change log names the same paths, so it leaves with them.
  const logged = await ctx.db
    .query("nodeLog")
    .withIndex("by_workspace_seq", (q) => q.eq("workspaceId", workspaceId))
    .take(PURGE_BATCH);
  for (const row of logged) await ctx.db.delete(row._id);
  // So do the links between them.
  const links = await ctx.db
    .query("nodeLinks")
    .withIndex("by_workspace_source", (q) => q.eq("workspaceId", workspaceId))
    .take(PURGE_BATCH);
  for (const row of links) await ctx.db.delete(row._id);
  // And the grants on them (`nodeAccess`): each names a row this batch just removed.
  const grants = await ctx.db
    .query("nodeAccess")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(PURGE_BATCH);
  for (const row of grants) await ctx.db.delete(row._id);
  if ([rows, logged, links, grants].some((batch) => batch.length === PURGE_BATCH)) {
    await ctx.scheduler.runAfter(0, internal.functions.nodesPurge.purge, { workspaceId });
  }
}

/**
 * Forget the workspace's tree: its bookkeeping, parsed rules and queued moves
 * at once, its rows a batch now and the rest in the background.
 *
 * A storage move (`storageMoved: true`) keeps rules that are the authority:
 * they are the workspace's decisions, not a description of the old bucket,
 * and the bucket's `privacy.md` may be an export behind them (one owed and
 * not yet written). Forgotten, the copy of that older file in the new bucket
 * would decide who sees what. They are written to the new bucket instead.
 */
export async function forgetWorkspaceTree(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  options: { storageMoved?: boolean } = {},
): Promise<void> {
  const trees = await ctx.db
    .query("nodeTrees")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of trees) await ctx.db.delete(row._id);
  const privacy = await ctx.db
    .query("nodePrivacy")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  const on = options.storageMoved === true && (await privacyAuthorityOn(ctx.db));
  for (const row of privacy) {
    if (on && isAuthority(row, true)) {
      // Nothing was written to the new bucket from them yet.
      await ctx.db.patch(row._id, { exportOwed: true, exportedEtag: undefined });
      await scheduleExport(ctx, workspaceId, 0);
    } else {
      await ctx.db.delete(row._id);
    }
  }
  // Queued moves describe objects in the bucket the workspace left, or in none.
  const moves = await ctx.db
    .query("moveQueue")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of moves) await ctx.db.delete(row._id);
  // So do keyed moves in pages: the rows they would carry are going too.
  const rowMoves = await ctx.db
    .query("rowMoves")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of rowMoves) await ctx.db.delete(row._id);
  const factState = await ctx.db
    .query("nodeFactState")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of factState) await ctx.db.delete(row._id);
  const days = await ctx.db
    .query("nodeChaosDays")
    .withIndex("by_workspace_day", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of days) await ctx.db.delete(row._id);
  // The access derivation's state goes with its rows (`lib/nodes/accessBackfill.ts`).
  const accessState = await ctx.db
    .query("nodeAccessState")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of accessState) await ctx.db.delete(row._id);
  // The icons, emoji names and forwarding ledger (`lib/smallData/purge.ts`).
  if (options.storageMoved === true) await resetSmallDataForStorage(ctx, workspaceId);
  else await purgeSmallDataBatch(ctx, workspaceId);
  await purgeBatch(ctx, workspaceId);
}

/** The next batch of a purge `forgetWorkspaceTree` started. */
export const purge = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }): Promise<null> => {
    await purgeBatch(ctx, workspaceId);
    return null;
  },
});

/** The next batch of a deleted workspace's icons, emoji names and forwarding ledger. */
export const purgeSmallData = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }): Promise<null> => {
    await purgeSmallDataBatch(ctx, workspaceId);
    return null;
  },
});

/** The workspace's storage now names a different bucket: its tree describes the old one. */
export const resetForStorage = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }): Promise<null> => {
    await forgetWorkspaceTree(ctx, workspaceId, { storageMoved: true });
    return null;
  },
});
