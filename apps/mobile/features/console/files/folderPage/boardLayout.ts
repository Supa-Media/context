/**
 * What the Board draws: Backlog as a slim rail at its left, then one column
 * per status, To do to Finished, each tinted by its group. Pure — no React,
 * no storage.
 *
 * The columns are the folder's statuses (`statusBands`), so dropping a card
 * on one writes that word, as it always has; a word nobody placed is still a
 * column, asking for its group. Backlog (any case) is taken out of them and
 * drawn as the rail — somewhere to park a card, out of the way — present
 * while the folder's list holds it or a task still says it, the same rule
 * that draws the List's Backlog band (`listLayout.ts`). A list with no
 * Backlog word has no rail.
 */

import { isBacklog } from "./listLayout";
import type { FolderGroup } from "./model";
import type { StatusBand } from "./statuses";
import type { StatusTone } from "./StatusPill";

export interface BoardColumn {
  readonly group: FolderGroup;
  readonly tone: StatusTone;
}

export interface BoardLayout {
  /** The Backlog status's cards; null when the folder has no Backlog. */
  readonly backlog: FolderGroup | null;
  readonly columns: readonly BoardColumn[];
}

export function boardLayout(bands: readonly StatusBand[]): BoardLayout {
  let backlog: FolderGroup | null = null;
  const columns: BoardColumn[] = [];
  for (const band of bands) {
    for (const group of band.columns) {
      if (backlog === null && isBacklog(group.value)) backlog = group;
      else columns.push({ group, tone: band.group ?? "unplaced" });
    }
  }
  return { backlog, columns };
}
