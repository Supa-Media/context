/**
 * What a project's List view draws, in order: its tasks by status, then its
 * plain notes. Pure — no React, no storage.
 *
 * - A child with a status is a **task**; one without is a **note**, drawn in
 *   the Notes section below every task, never as a "No status" task row.
 * - `backlog` (any case) is its own **folded band first** — ideas and later
 *   work, out of the way until opened. The Done group is a folded band at
 *   the end of the tasks. A folder whose list has no backlog word has no
 *   Backlog band. Words nobody placed come before Done, so a folded band
 *   never hides the one question the page asks.
 * - A **Backlog folder** (`backlog/` directly in the folder, any case) is
 *   the Backlog too: its contents are the band's rows, it is not also drawn
 *   as a row, and parking moves a row into it (`tasks/backlogFolder.ts`).
 *   For somebody who may write the band is drawn even when empty, as the
 *   place to drop a row — wherever the list has a backlog word or the folder
 *   has a Backlog folder; a reader sees it only when something is in it.
 * - A section is named by its one status when it has one ("To do",
 *   "Finished"), and by its group when it holds several, each then under its
 *   own heading.
 * - A task that is a folder carries its **subtasks** and then the **notes in
 *   it**, one level down.
 * - Under a filter (`showFilter.ts`) a task stays when it or any subtask
 *   matches; one kept only for a subtask is `dim`, and carries only the
 *   subtasks that match. Notes are not tasks and are left out. A section
 *   with nothing left is dropped, and says `shown` of `total` otherwise;
 *   the layout says the same over every section, for the bar's "3 of 7".
 *
 * See "Tasks and notes" in `docs/decisions/folder-lists.md`.
 */

import type { ListNote } from "../listBlock/model";
import { groupLabel } from "../listBlock/words";
import { compareTasks, groupFolderItems, taskChildren, type FolderItem } from "./model";
import { GROUP_LABELS, statusBands, type StatusGroup, type StatusList } from "./statuses";

/** The one status word drawn as its own band before everything else. */
export const BACKLOG = "backlog";
export const BACKLOG_HINT = "Ideas and later work, out of the way";
/** What an empty Backlog band says to somebody who may drop on it. */
export const BACKLOG_EMPTY_HINT = "Drop here to park";

export function isBacklog(status: string): boolean {
  return status.trim().toLowerCase() === BACKLOG;
}

export interface TaskEntry {
  readonly item: FolderItem;
  /** The subtasks drawn under it when it is opened; under a filter, only those that match. */
  readonly subtasks: readonly FolderItem[];
  /** Plain notes in a task folder, drawn after its subtasks; none under a filter. */
  readonly notes: readonly FolderItem[];
  /** Kept only because a subtask matches the filter. */
  readonly dim: boolean;
}

export interface LayoutColumn {
  /** The status as the first task spelled it. */
  readonly value: string;
  readonly label: string;
  readonly rows: readonly TaskEntry[];
}

export interface LayoutSection {
  /** `backlog`, a group, or `unplaced` for words nobody placed. */
  readonly key: "backlog" | StatusGroup | "unplaced";
  /** The status group, for its tone; null for words nobody placed. */
  readonly group: StatusGroup | null;
  readonly label: string;
  /** Drawn as one line until opened: Backlog and the Done group. */
  readonly folded: boolean;
  /** Backlog only: the Backlog folder its rows live in, where a drop moves a row; null for the word alone. */
  readonly folder?: string | null;
  readonly columns: readonly LayoutColumn[];
  /** Tasks drawn, and tasks in it at all: they differ only under a filter. */
  readonly shown: number;
  readonly total: number;
}

export interface ListLayout {
  readonly sections: readonly LayoutSection[];
  /** The page's plain notes; none under a filter. */
  readonly notes: readonly FolderItem[];
  readonly filtered: boolean;
  /** Top-level tasks drawn, and in the List at all, across every section — dropped ones too. */
  readonly shown: number;
  readonly total: number;
}

type Match = (item: FolderItem) => boolean;

/** Where a page's Backlog is, beyond its backlog word. */
export interface BacklogPlace {
  /** The page's Backlog folder (`backlogFolderOf`), whose contents are the band's rows; null for none. */
  readonly folder: FolderItem | null;
  /** Draw the band even when empty — for somebody who may drop on it, where the page has a Backlog. */
  readonly always: boolean;
}

function entryFor(item: FolderItem, notes: readonly ListNote[], match: Match | null): TaskEntry | null {
  const children = item.kind === "folder" ? taskChildren(item.path, notes) : { subtasks: [], notes: [] };
  if (match === null) return { item, subtasks: children.subtasks, notes: children.notes, dim: false };
  const subtasks = children.subtasks.filter(match);
  const self = match(item);
  if (!self && subtasks.length === 0) return null;
  return { item, subtasks, notes: [], dim: !self };
}

export function listLayout(
  items: readonly FolderItem[],
  list: StatusList,
  notes: readonly ListNote[],
  match: Match | null,
  place: BacklogPlace = { folder: null, always: false },
): ListLayout {
  const parkedIn = place.folder;
  // The Backlog folder is the band, never a row of its own.
  const own = parkedIn === null ? items : items.filter((item) => item.path !== parkedIn.path);
  const tasks = own.filter((item) => item.status !== "");
  const bands = statusBands(groupFolderItems(tasks, "status", list), list);
  const sections: LayoutSection[] = [];
  const backlog: { value: string; items: readonly FolderItem[] }[] = [];
  const count = { shown: 0, total: 0 };

  const section = (
    key: LayoutSection["key"],
    group: StatusGroup | null,
    fallback: string,
    columns: readonly { value: string; items: readonly FolderItem[] }[],
  ): LayoutSection | null => {
    const used = columns.filter((column) => column.items.length > 0);
    const drawn = used
      .map((column) => ({
        value: column.value,
        label: groupLabel("status", column.value),
        rows: column.items.map((item) => entryFor(item, notes, match)).filter((row): row is TaskEntry => row !== null),
      }))
      .filter((column) => column.rows.length > 0);
    const shown = drawn.reduce((sum, column) => sum + column.rows.length, 0);
    const total = used.reduce((sum, column) => sum + column.items.length, 0);
    count.shown += shown;
    count.total += total;
    if (shown === 0) return null;
    const label = key !== "unplaced" && used.length === 1 ? groupLabel("status", used[0].value) : fallback;
    return { key, group, label, folded: key === "backlog" || key === "done", columns: drawn, shown, total };
  };

  for (const band of bands) {
    const rest = band.columns.filter((column) => {
      if (!isBacklog(column.value)) return true;
      backlog.push(column);
      return false;
    });
    const key = band.group ?? "unplaced";
    const drawn = section(key, band.group, band.group === null ? band.label : GROUP_LABELS[band.group], rest);
    if (drawn !== null) sections.push(drawn);
  }
  if (parkedIn !== null) {
    // What is parked in the folder, task or not, in task order: one column with the word's.
    const inside = taskChildren(parkedIn.path, notes);
    const parked = [...inside.subtasks, ...inside.notes].sort(compareTasks);
    const word = backlog[0];
    const merged = word === undefined ? parked : [...word.items, ...parked].sort(compareTasks);
    backlog.splice(0, backlog.length, { value: word?.value ?? BACKLOG, items: merged });
  }
  const first = section("backlog", "not-started", "Backlog", backlog);
  const hasPlace = parkedIn !== null || hasBacklogWord(list);
  if (first !== null) sections.unshift({ ...first, label: "Backlog", folder: parkedIn?.path ?? null });
  else if (place.always && hasPlace) {
    sections.unshift({ key: "backlog", group: "not-started", label: "Backlog", folded: true, columns: [], shown: 0, total: 0, folder: parkedIn?.path ?? null });
  }
  // The Done group folds at the end of the tasks, after any word still asking for a group.
  const done = sections.findIndex((each) => each.key === "done");
  if (done !== -1) sections.push(...sections.splice(done, 1));

  return {
    sections,
    notes: match === null ? own.filter((item) => item.status === "") : [],
    filtered: match !== null,
    shown: count.shown,
    total: count.total,
  };
}

/** Whether the list has a backlog word in any group. */
function hasBacklogWord(list: StatusList): boolean {
  return Object.values(list).some((words) => words.some(isBacklog));
}

/**
 * What "Make it a task" writes: the folder's first Not started status that
 * is not backlog (`to do` by default) — somebody pressing it means now, not
 * later — else the first there is.
 */
export function makeItTaskStatus(list: StatusList): string {
  const start = list["not-started"];
  return start.find((word) => !isBacklog(word)) ?? start[0] ?? list["in-progress"][0] ?? "";
}
