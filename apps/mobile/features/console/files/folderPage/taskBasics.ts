/**
 * The few task rules the Board, the side panel and the counts share, now that
 * the List draws no layout of its own (the owner, 2026-10-10: the List is the
 * Notes rows with a dot, a count and a face; see `rowExtras.tsx`). Pure.
 */

import type { ListNote } from "../listBlock/model";
import { taskChildren, type FolderItem } from "./model";
import type { StatusList } from "./statuses";

/** The one status word drawn as its own rail before the Board's columns. */
export const BACKLOG = "backlog";

export function isBacklog(status: string): boolean {
  return status.trim().toLowerCase() === BACKLOG;
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

/** Every task on the page, and every subtask in a task folder: what the counts count. */
export function tasksWithSubtasks(items: readonly FolderItem[], notes: readonly ListNote[]): FolderItem[] {
  const out: FolderItem[] = [];
  for (const item of items) {
    if (item.status === "") continue;
    out.push(item);
    if (item.kind === "folder") out.push(...taskChildren(item.path, notes).subtasks);
  }
  return out;
}
