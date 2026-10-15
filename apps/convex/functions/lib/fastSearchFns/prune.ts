/**
 * Once a day, each `ready` fast search database is checked against its bucket
 * for rows whose notes are gone (`filesFns/prunePass.ts`).
 *
 * Run from the fifteen-minute backfill sweep (`sweepStalledBackfills`), the
 * longest unchecked first, a bounded batch per run: a deployment with many
 * databases spreads the day's checks out instead of listing every bucket at
 * once. A row is marked before its check is scheduled, so a check that fails
 * waits a day like one that succeeded, rather than retrying every run.
 */

import { internal } from "../../../_generated/api";
import type { MutationCtx } from "../../../_generated/server";
import { workspaceArchived } from "../archivedWorkspaces";

/** Links one day's check may chain (`filesFns/prunePass.ts`). */
export const PRUNE_CHAIN = 10;
/** How often each `ready` database is checked. */
export const PRUNE_EVERY_MS = 24 * 60 * 60 * 1_000;
/** Checks one sweep run may start. */
const PRUNE_BATCH = 20;

export async function schedulePrunes(ctx: MutationCtx, now = Date.now()): Promise<number> {
  const rows = await ctx.db
    .query("searchIndexes")
    // Rows never checked have no `prunedAt` and sort first.
    .withIndex("by_status_pruned", (q) => q.eq("status", "ready").lt("prunedAt", now - PRUNE_EVERY_MS))
    .take(PRUNE_BATCH);
  let started = 0;
  for (const row of rows) {
    // Marked either way, so a row skipped today is not first in line every run.
    await ctx.db.patch(row._id, { prunedAt: now });
    if (!row.optedIn) continue;
    if (await workspaceArchived(ctx.db, row.workspaceId)) continue;
    await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId: row.workspaceId,
      scope: "private",
      operation: { kind: "pruneIndex", passes: PRUNE_CHAIN },
    });
    started += 1;
  }
  return started;
}
