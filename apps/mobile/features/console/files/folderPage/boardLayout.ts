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
 * Backlog word has no rail — unless the folder has a Backlog folder, which
 * is the rail's contents (`parkedOnBoard`).
 */

import type { ListNote } from "../listBlock/model";
import { isBacklog } from "./listLayout";
import { compareTasks, taskChildren, type FolderGroup, type FolderItem } from "./model";
import { planUnpark } from "./tasks/backlogFolder";
import { taskRefOf } from "./tasks/taskEdits";
import type { TaskControls } from "./tasks/useTaskActions";
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

/**
 * The rail where Backlog is a folder (`tasks/backlogFolder.ts`): what the
 * folder holds, and — for somebody who may write — the move into it (a card
 * dropped on the rail) and out of it (a parked card dropped on a column,
 * which also gives it that column's status). Null where the page has no
 * Backlog folder, and for a reader when nothing is parked.
 */
export interface BoardParked {
  readonly items: readonly FolderItem[];
  /** Null for somebody who may not write. */
  readonly park: ((path: string) => void) | null;
  readonly unpark: ((path: string, status: string) => void) | null;
}

export function parkedOnBoard(
  folder: FolderItem | null,
  notes: readonly ListNote[],
  controls: Pick<TaskControls, "lookup" | "perform" | "parkPlan" | "snapshot"> | null,
  writer: boolean,
): BoardParked | null {
  if (folder === null) return null;
  const inside = taskChildren(folder.path, notes);
  const items = [...inside.subtasks, ...inside.notes].sort(compareTasks);
  if (items.length === 0 && !writer) return null;
  if (controls === null) return { items, park: null, unpark: null };
  const item = (path: string) => controls.lookup(path)?.item;
  return {
    items,
    park: (path) => {
      const found = item(path);
      if (found !== undefined) void controls.perform(controls.parkPlan(found));
    },
    unpark: (path, status) => {
      const found = item(path);
      if (found !== undefined) void controls.perform(planUnpark(taskRefOf(found), folder.path, status, controls.snapshot()));
    },
  };
}
