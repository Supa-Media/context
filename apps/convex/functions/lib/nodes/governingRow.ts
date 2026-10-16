/**
 * Which access row decides a path, and whether a caller holds its edit name.
 *
 * The walk is the one `canSee` makes through `visibilityOf` and
 * `overrideFor` (`lib/privacy.ts`): an exact note row first, else the folder
 * row with the longest prefix that contains the path. This returns the row
 * instead of its rendered visibility, because a team row with a list renders
 * as `team` for a member (`rowAccess.ts` `visibilityFor`) and the list would be
 * lost if the walk went through the rendered rules.
 *
 * A row with neither a base nor a list is absent. `renderAccess` skips it, so
 * the walk does too: it inherits, and its ancestor governs.
 *
 * Pure: no database, no clock. The caller passes the workspace's own rows, so
 * a name issued for another workspace's row cannot match here.
 */

import { accessNamesFor, editNameFor, type AccessRow, type Caller } from "./rowAccess";

function sets(row: AccessRow): boolean {
  return row.base !== undefined || row.grantees.length > 0;
}

/** The row whose setting decides `path`, or null when nothing above it sets access. */
export function governingRowOf(rows: readonly AccessRow[], path: string): AccessRow | null {
  let folder: AccessRow | null = null;
  for (const row of rows) {
    if (!sets(row)) continue;
    if (row.kind === "file") {
      // An exact note row is an override in the engine and beats any folder.
      if (row.path === path) return row;
      continue;
    }
    if (row.path !== path && !path.startsWith(row.path + "/")) continue;
    if (folder === null || row.path.length > folder.path.length) folder = row;
  }
  return folder;
}

/**
 * Whether `caller` may write `path` by an edit grant: they hold the edit name
 * of the row that governs it. A view grant is not enough, and an edit grant on
 * some other row is not enough.
 *
 * This answers the grant question only. The console also requires the path to
 * be visible and the operation to be one a member may do (see the member write
 * path in `lib/filesFns/access.ts`).
 */
export function canEditPath(rows: readonly AccessRow[], caller: Caller, path: string): boolean {
  const governing = governingRowOf(rows, path);
  if (governing === null) return false;
  return accessNamesFor(caller, [governing]).includes(editNameFor(governing.noteId));
}
