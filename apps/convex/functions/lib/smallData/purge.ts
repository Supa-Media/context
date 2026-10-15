/**
 * A workspace's small data leaving with it (`nodesPurge.ts`).
 *
 *  - **Deleted**: every row goes (icons, emoji names, the ledger and the
 *    state), a batch with the caller's transaction and the rest in the
 *    background, as the tree's rows do. The bucket's files are the
 *    customer's and are not touched.
 *  - **Storage moved to another bucket**: the icons and the ledger are the
 *    workspace's own decisions, not a description of the old bucket, so they
 *    stay, and are written to the new bucket's files once its own have been
 *    imported and merged in. The emoji rows name pictures in the old bucket,
 *    so they go, and the import reads the new bucket's.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { requestSmallDataSync, smallDataStateOf } from "./state";

/** Rows one batch deletes from each table. */
const PURGE_BATCH = 1_000;

async function deleteEmoji(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  const rows = await ctx.db
    .query("customEmoji")
    .withIndex("by_workspace_name", (q) => q.eq("workspaceId", workspaceId))
    .take(PURGE_BATCH);
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length === PURGE_BATCH;
}

/** One batch of a deleted workspace's rows; the next is scheduled while any remain. */
export async function purgeSmallDataBatch(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  const icons = await ctx.db
    .query("folderIcons")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
    .take(PURGE_BATCH);
  for (const row of icons) await ctx.db.delete(row._id);
  const ledger = await ctx.db
    .query("forwardingEntries")
    .withIndex("by_workspace_seq", (q) => q.eq("workspaceId", workspaceId))
    .take(PURGE_BATCH);
  for (const row of ledger) await ctx.db.delete(row._id);
  const moreEmoji = await deleteEmoji(ctx, workspaceId);
  if (icons.length === PURGE_BATCH || ledger.length === PURGE_BATCH || moreEmoji) {
    await ctx.scheduler.runAfter(0, internal.functions.nodesPurge.purgeSmallData, { workspaceId });
    return;
  }
  const state = await smallDataStateOf(ctx.db, workspaceId);
  if (state !== null) await ctx.db.delete(state._id);
}

/** The workspace now names another bucket: import that one's files, then write the merged rows to it. */
export async function resetSmallDataForStorage(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  while (await deleteEmoji(ctx, workspaceId)) {
    // A batch at a time; a workspace past a few thousand emoji has none to spare.
  }
  const state = await smallDataStateOf(ctx.db, workspaceId);
  if (state === null) return;
  const anyIcon = await ctx.db
    .query("folderIcons")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
    .first();
  const anyEntry = await ctx.db
    .query("forwardingEntries")
    .withIndex("by_workspace_seq", (q) => q.eq("workspaceId", workspaceId))
    .first();
  await ctx.db.patch(state._id, {
    importedAt: undefined,
    syncAt: undefined,
    // Owed to the new bucket, written once its own files are merged in.
    ...(anyEntry === null ? {} : { forwardingVersion: state.forwardingVersion + 1 }),
    ...(anyIcon === null ? {} : { iconsVersion: state.iconsVersion + 1 }),
  });
  await requestSmallDataSync(ctx, workspaceId);
}
