/**
 * One page of the check before a workspace builds its paths from parents (`functions/treeFlips.ts`;
 * `paths-on-read.md`, "The flip"). Every row is read in stored-path order and asked two things of the tree
 * its parents make: is the path built from its parents the path it stores, and is it the row the tree finds
 * at that path. A live row that fails either would be shown somewhere else, or not at all, the moment the
 * workspace flips. Nothing is set right here; the parent check (`parentCheck.ts`) does that.
 */

import type { Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";
import { treePaths } from "./paths";

export interface FlipPage {
  /** The last stored path the page read, or `null` when the walk reached the end. */
  last: string | null;
  rows: number;
  mismatches: number;
  goneMismatches: number;
}

/** Check the rows after `after` in stored-path order, `limit` of them. */
export async function checkFlipPage(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  after: string | undefined,
  limit: number,
): Promise<FlipPage> {
  const rows = await db
    .query("nodes")
    .withIndex("by_workspace_path", (q) =>
      after === undefined ? q.eq("workspaceId", workspaceId) : q.eq("workspaceId", workspaceId).gt("path", after),
    )
    .take(limit);
  const page: FlipPage = { last: rows.length < limit ? null : rows[rows.length - 1].path, rows: 0, mismatches: 0, goneMismatches: 0 };
  const tree = treePaths(db, workspaceId);
  for (const row of rows) {
    const built = await tree.pathOf(row);
    if (row.goneAt !== undefined) {
      if (built !== row.path) page.goneMismatches += 1;
      continue;
    }
    page.rows += 1;
    // The tree finds the live row at a name first, so a second live row at the name is never reached.
    if (built !== row.path || (await tree.liveAt(row.path))?._id !== row._id) page.mismatches += 1;
  }
  return page;
}
