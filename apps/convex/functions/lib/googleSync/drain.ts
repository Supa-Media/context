/**
 * Keeping one workspace's Google passes back to back.
 *
 * The sweep runs one pass per workspace at a time (the shared-writer lock in
 * `sweepDueGoogleSyncs`), one product per pass. Waiting for the five-minute
 * cron between passes meant a person with three accounts, each with Gmail,
 * Calendar and Chat, got one pass every five minutes for all nine: a pushed
 * email could wait most of an hour behind routine polls. So when a pass
 * reports, a sweep is queued at once if anything else in its workspace is
 * due, and the sweep serves pushed connections first.
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { isDue, productBackingOff, SYNC_STALL_MS, syncableProductsOf } from "../googleSchedule";

/** More than one person ever connects, and the workspace's rows are read in one go. */
const WORKSPACE_ROWS = 20;

type Row = Doc<"googleConnections">;

/** Google told us something changed for this row, on a product not waiting out a failure. */
export function pushedNow(row: Row, now: number): boolean {
  const pending = row.push?.pending;
  if (pending === undefined) return false;
  return syncableProductsOf(row).some(
    (product) => pending[product] !== undefined && !productBackingOff(row, product, now),
  );
}

/**
 * The sweep's order: pushed connections first, then by due time as the index
 * gave them. Stable, so the index's order holds within each half.
 */
export function pushedFirst(rows: Row[], now: number): Row[] {
  return [...rows.filter((row) => pushedNow(row, now)), ...rows.filter((row) => !pushedNow(row, now))];
}

/**
 * Would a sweep run now start something in this workspace? The same tests the
 * sweep applies, so a queued sweep is never one that finds nothing to claim.
 *
 * A row that is only draining a backlog (`syncCatchUp`) does not count: those
 * passes keep the cron's pace, so a long catch-up cannot hold Gmail's quota
 * at one pass after another.
 */
export async function workspaceHasDuePass(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  now: number,
): Promise<boolean> {
  const rows = await ctx.db
    .query("googleConnections")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(WORKSPACE_ROWS);
  return rows.some(
    (row) =>
      row.disconnectedAt === undefined &&
      row.health !== "reconnect_required" &&
      row.nextSyncAt !== undefined &&
      row.nextSyncAt <= now &&
      (row.syncStartedAt === undefined || now - row.syncStartedAt >= SYNC_STALL_MS) &&
      isDue({ ...row, syncCatchUp: undefined }, now),
  );
}

/** After a pass reports: start the workspace's next due pass now rather than at the next cron tick. */
export async function queueWorkspaceSweep(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<void> {
  if (!(await workspaceHasDuePass(ctx, workspaceId, Date.now()))) return;
  await ctx.scheduler.runAfter(0, internal.functions.googleSync.sweepDueGoogleSyncs, {});
}
