/**
 * A new workspace is keyed from its first binding, not by the cron later
 * (`noteIds.keepCurrent`, which left a new workspace on path keys for its
 * first 15 to 30 minutes, 2026-10-22).
 *
 * Only a workspace with nothing to copy is born keyed: no tree rows, no tree
 * state and no copy row yet, bound to its own managed bucket, which is new and empty by
 * construction. Its first notes are then written at their id keys from the
 * start (`idLayout.js`, a keyed write with no row creates one). A bucket the
 * person brings may already hold files, which the cron's first pass copies
 * in before it flips, so it is left to that.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { copyRowOf } from "./state";

/** Mark `workspaceId` keyed with nothing left to flip, when it qualifies; whether it did. */
export async function keyIfBornEmpty(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  if ((await copyRowOf(ctx.db, workspaceId)) !== null) return false;
  const anyRow = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
    .first();
  if (anyRow !== null) return false;
  const tree = await ctx.db
    .query("nodeTrees")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (tree !== null) return false;
  const now = Date.now();
  // Its tree is whole from the start: a keyed workspace is never swept (`nodeSweepDue`), so nothing else would say so,
  // and an unready tree answers every reader "loading".
  await ctx.db.insert("nodeTrees", { workspaceId, status: "ready", dirty: false, files: 0, sweptAt: now });
  await ctx.db.insert("noteIdCopies", {
    workspaceId,
    status: "done",
    runId: 1,
    passSeq: 0,
    files: 0,
    copied: 0,
    failed: 0,
    failures: [],
    updatedAt: now,
    keyedAt: now,
    keyedDoneAt: now,
    // Nothing was keyed before the walks told rows: no recheck owed (`keyedRecheck.ts`).
    keyedRecheckAt: now,
    flipped: 0,
  });
  return true;
}
