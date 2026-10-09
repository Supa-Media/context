/**
 * The staff console's tree index panel: every workspace's tree table
 * (`apps/mcp/src/tree/table.js`), how full it is, and Fill.
 *
 * Asked for by the owner, 2026-10-08 ("I need to see this in the admin panel,
 * the health of everyone's tree index, also why can't we just run all of them
 * now"). The state lives in each workspace's own search database, not here,
 * so the report is an action that asks each one, through the credential
 * barrier (`treeState`). It reads counts and the table's own bookkeeping —
 * never a path.
 */

import type { Infer } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../../../_generated/server";
import { projectionTargetForWorkspaceHandler } from "../fastSearchFns/internal";
import { type TreeIndexRow, treeIndexReportValidator } from "./treeIndexValidators";

/** Workspaces one report reads: a bound on a loop, not on any deployment we have. */
export const TREE_REPORT_ROWS = 500;
/** Databases asked at once. */
const CONCURRENCY = 6;

export interface TreeTarget {
  workspaceId: Id<"workspaces">;
  slug: string | null;
  databaseId: string;
  state: "backfilling" | "ready";
}

/** Every workspace with a search database the tree table can live in. */
export async function treeTargetsHandler(ctx: QueryCtx): Promise<{ targets: TreeTarget[]; truncated: boolean }> {
  const found = await ctx.db.query("searchIndexes").take(TREE_REPORT_ROWS + 1);
  const targets: TreeTarget[] = [];
  for (const row of found.slice(0, TREE_REPORT_ROWS)) {
    const target = await projectionTargetForWorkspaceHandler(ctx, { workspaceId: row.workspaceId });
    if (target === null) continue;
    const workspace = await ctx.db.get(row.workspaceId);
    targets.push({ workspaceId: row.workspaceId, slug: workspace?.slug ?? null, ...target });
  }
  return { targets, truncated: found.length > TREE_REPORT_ROWS };
}

async function rowFor(ctx: ActionCtx, target: TreeTarget): Promise<TreeIndexRow> {
  const base = { workspaceId: target.workspaceId, slug: target.slug };
  try {
    // Through the credential barrier, which opens the database and nothing else.
    const answer = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: target.workspaceId,
      scope: "private",
      operation: { kind: "treeState" },
    });
    if (answer.kind !== "treeState") throw new Error("not a tree state");
    return {
      ...base,
      status: answer.status,
      rows: answer.rows,
      sweptAt: answer.sweptAt,
      dirty: answer.dirty,
      error: answer.error,
    };
  } catch {
    return { ...base, status: "unreachable", rows: null, sweptAt: null, dirty: false, error: null };
  }
}

/** Ask every database, a few at a time; the ones that need attention first. */
export async function treeIndexReport(
  ctx: ActionCtx,
  found: { targets: TreeTarget[]; truncated: boolean },
): Promise<Infer<typeof treeIndexReportValidator>> {
  const rows: TreeIndexRow[] = [];
  for (let start = 0; start < found.targets.length; start += CONCURRENCY) {
    rows.push(...(await Promise.all(found.targets.slice(start, start + CONCURRENCY).map((target) => rowFor(ctx, target)))));
  }
  const order = { unreachable: 0, unsupported: 1, empty: 2, filling: 3, ready: 4 } as const;
  rows.sort((a, b) => order[a.status] - order[b.status] || (b.rows ?? 0) - (a.rows ?? 0));
  return { rows, truncated: found.truncated };
}

/**
 * Start a sweep now: for one workspace, or every one with a database. A
 * sweep lists the bucket into the table a piece at a time and chains itself
 * until it is done; one already running is joined, not doubled
 * (`sweepTreePass` keeps the earliest start).
 */
export async function fillTreeIndexes(ctx: ActionCtx, targets: readonly TreeTarget[]): Promise<number> {
  let started = 0;
  for (const target of targets) {
    await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId: target.workspaceId,
      scope: "private",
      operation: { kind: "sweepTree", passes: 0 },
    });
    started += 1;
  }
  return started;
}
