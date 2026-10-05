/**
 * Jev spend per workspace, for the staff roster's AI column.
 *
 * ## Attribution: an account pays for the workspaces it owns
 *
 * `jevUsage` is metered per (day, feature, workspace) and carries no user id:
 * a feature runs on a workspace's behalf, and the workspace's plan is what
 * gates it. So an account's spend is the sum over every workspace it holds
 * the `owner` role in — the same accounts the plan column already reads. A
 * workspace somebody is only a member of is charged to its owner, not to
 * them; a workspace with two owners shows its spend on both rows, so the
 * column is per account, never a total to add up.
 *
 * ## Window and cost
 *
 * The census window, matching `jevUsageReport`, which is windowed too. Each
 * workspace is one ranged read on `by_workspace_day`, never a scan, and the
 * whole roster shares one row budget: the census already reads several
 * bounded pages, and fifty accounts times their workspaces times ninety days
 * times every feature is not a number to leave unbounded. A workspace whose
 * read the budget cut is reported as `partial`, so the screen prints a floor
 * as a floor.
 *
 * Numbers only: cost, never a question, an answer or a feature's input.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";

/** Usage rows the roster's AI column may read in one census. */
export const AI_SPEND_READ_BUDGET = 4_000;

export interface AiSpend {
  /** Micro-USD per workspace id, inside the window. Absent means none. */
  spend: Map<string, number>;
  /** Workspaces whose figure is a floor because the budget ran out. */
  partial: Set<string>;
}

export async function aiSpendByWorkspace(
  ctx: QueryCtx,
  workspaceIds: readonly Id<"workspaces">[],
  sinceDay: string,
  budget: number = AI_SPEND_READ_BUDGET,
): Promise<AiSpend> {
  const spend = new Map<string, number>();
  const partial = new Set<string>();
  let left = budget;
  for (const workspaceId of new Set(workspaceIds)) {
    const key = String(workspaceId);
    if (left <= 0) {
      partial.add(key);
      continue;
    }
    const rows = await ctx.db
      .query("jevUsage")
      .withIndex("by_workspace_day", (q) => q.eq("workspaceId", workspaceId).gte("day", sinceDay))
      .take(left + 1);
    if (rows.length > left) {
      partial.add(key);
      rows.length = left;
    }
    left -= rows.length;
    const total = rows.reduce((sum, row) => sum + row.costMicroUsd, 0);
    if (total > 0) spend.set(key, total);
  }
  return { spend, partial };
}
