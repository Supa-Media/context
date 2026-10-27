/**
 * One page of the check that every row's parent and name are its path
 * (`functions/treeParents.ts`; `paths-on-read.md`, "Every row's parent and
 * name are its path"). Paths are going to be built from `parentId` and `name`
 * when read, so before that every live row must already say, through them,
 * exactly the path it stores.
 *
 * The stored path is the truth today, so a page sets `parentId` and `name`
 * from it: the parent is the live folder row at the path's folder (none at
 * the top level), and the name is the path's last segment (`""` for a folder
 * marker, `a/`). A row whose folder holds no live folder row, or a path two
 * live rows hold, is counted and left: a parent cannot be guessed.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { nameOf } from "./table";

export interface ParentPage {
  /** The last path the page read, or `null` when the walk reached the end. */
  last: string | null;
  rows: number;
  repairedNames: number;
  repairedParents: number;
  orphans: number;
  /** Of `orphans`, those under a dot folder (`.context/trash/…`), which is never a row of its own. */
  hiddenOrphans: number;
  duplicates: number;
}

/** The folder a path sits in, or `null` at the top level. A folder marker `a/` sits in `a`. */
export function folderOf(path: string): string | null {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? null : path.slice(0, slash);
}

/** Check, and set right, the live rows after `after` in path order, `limit` of them. */
export async function checkParents(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  after: string | undefined,
  limit: number,
): Promise<ParentPage> {
  const rows = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) =>
      after === undefined ? q.eq("workspaceId", workspaceId) : q.eq("workspaceId", workspaceId).gt("path", after),
    )
    .take(limit);
  const page: ParentPage = { last: rows.length < limit ? null : rows[rows.length - 1].path, rows: 0, repairedNames: 0, repairedParents: 0, orphans: 0, hiddenOrphans: 0, duplicates: 0 };
  // A path's live rows, and a folder's: one read each per page.
  const liveAt = new Map<string, Doc<"nodes">[]>();
  const live = async (path: string): Promise<Doc<"nodes">[]> => {
    const known = liveAt.get(path);
    if (known !== undefined) return known;
    const held = (
      await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
        .take(8)
    ).filter((row) => row.goneAt === undefined);
    liveAt.set(path, held);
    return held;
  };

  for (const row of rows) {
    if (row.goneAt !== undefined) continue;
    page.rows += 1;
    const holders = await live(row.path);
    if (holders.length > 1) {
      // Counted once per path, on its first row.
      if (holders[0]._id === row._id) page.duplicates += 1;
      continue;
    }
    const folder = folderOf(row.path);
    let parentId: Id<"nodes"> | undefined;
    if (folder !== null) {
      const parents = (await live(folder)).filter((parent) => parent.kind === "folder");
      if (parents.length !== 1) {
        page.orphans += 1;
        if (row.path.startsWith(".")) page.hiddenOrphans += 1;
        continue;
      }
      parentId = parents[0]._id;
    }
    const patch: Partial<Doc<"nodes">> = {};
    const name = nameOf(row.path);
    if (row.name !== name) {
      patch.name = name;
      page.repairedNames += 1;
    }
    if (row.parentId !== parentId) {
      patch.parentId = parentId;
      page.repairedParents += 1;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(row._id, patch);
  }
  return page;
}
