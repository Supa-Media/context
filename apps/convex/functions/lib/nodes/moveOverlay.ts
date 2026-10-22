/**
 * The tree as people see it while moves are pending (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`).
 *
 * A `nodes` row is where a note sits. A keyed move still moving (`rowMoves`,
 * `rowMoveChunks.ts`) says where the tree shows it instead, so a move of any
 * size is one row and every listing reads it at once. This file folds the rows of one
 * folder through those moves (`movePaths.ts`). Who may see each name
 * is still decided after this, by the unchanged `listFolder` over the rows it
 * returns.
 *
 * Folding never stores anything: a row's `path` stays the bucket key, so a
 * sweep, a re-check and the parity check keep comparing like with like.
 */

import type { Doc } from "../../../_generated/dataModel";
import { logicalPath, physicalCandidates } from "./movePaths";

/** A pending move as every fold reads it: paths as they were named, oldest first. */
export interface PendingMove {
  from: string;
  to: string;
}

/** The folder a key is listed in: a marker key (`a/`) is listed in the folder it marks. */
export function folderOfKey(key: string): string {
  if (key.endsWith("/")) return key.slice(0, -1);
  const slash = key.lastIndexOf("/");
  return slash < 0 ? "" : key.slice(0, slash);
}

/** The last segment of a key; a marker key's name is "", as `nodeKey` stores it. */
function nameOfKey(key: string): string {
  if (key.endsWith("/")) return "";
  const slash = key.lastIndexOf("/");
  return slash < 0 ? key : key.slice(slash + 1);
}

type Row = Doc<"nodes">;
type Children = (folder: string) => Promise<{ rows: Row[]; more: boolean }>;
type ByPath = (path: string) => Promise<Row | null>;

/**
 * The live children of `folder` as the tree shows it, each with its `path`
 * and `name` folded through `moves`.
 *
 * - Every bucket folder that folds to `folder` contributes its children: the
 *   folder itself where things already sit, and each old name a pending move
 *   is still carrying away from.
 * - Each move contributes the thing it moved, wherever its old place was, so
 *   a note or folder moved into `folder` shows there at once.
 * - A row whose folded path is not directly in `folder` is left out. That is
 *   how a moved thing disappears from the folder it left.
 * - One entry per folded path. Where both the old and the new key are in the
 *   bucket for a moment (copied, not yet retired), the new one is kept.
 */
export async function childrenThroughMoves(
  folder: string,
  moves: readonly PendingMove[],
  childrenOf: Children,
  byPath: ByPath,
): Promise<{ rows: Row[]; more: boolean }> {
  const sources = folder === "" ? [""] : (physicalCandidates(folder, moves) as string[]);
  const found: Row[] = [];
  let more = false;
  for (const source of sources) {
    const page = await childrenOf(source);
    found.push(...page.rows);
    more = more || page.more;
  }
  for (let index = 0; index < moves.length; index += 1) {
    for (const source of physicalCandidates(moves[index].from, moves.slice(0, index)) as string[]) {
      const row = await byPath(source);
      if (row !== null && row.goneAt === undefined) found.push(row);
    }
  }
  const byFolded = new Map<string, { landed: boolean; row: Row }>();
  for (const row of found) {
    const folded = logicalPath(row.path, moves) as string;
    if (folderOfKey(folded) !== folder) continue;
    // The row already at its folded key is the copy that has landed.
    const landed = row.path === folded;
    if (byFolded.get(folded)?.landed === true) continue;
    if (byFolded.has(folded) && !landed) continue;
    byFolded.set(folded, { landed, row: { ...row, path: folded, name: nameOfKey(folded) } });
  }
  return { rows: [...byFolded.values()].map((entry) => entry.row), more };
}

/**
 * Pages of rows in key order, folded through `moves`, for a whole-tree walk
 * (`manifestStore.ts`). Folding reorders keys, so a walk through this reads
 * every page rather than stopping at a prefix; `seen` drops the second of two
 * keys that fold to one path, across pages.
 */
export function foldRows<R extends { path: string }>(rows: R[], moves: readonly PendingMove[], seen: Set<string>): R[] {
  const out: R[] = [];
  for (const row of rows) {
    const folded = logicalPath(row.path, moves) as string;
    // A note a queued trash carries folds under `.context/`, which the tree never holds.
    if (folded.startsWith(".")) continue;
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push({ ...row, path: folded });
  }
  return out;
}
