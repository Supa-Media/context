/**
 * Backlog as a folder: `backlog/` directly in a page's folder holds what is
 * parked there (the owner's choice for the projects folder, 2026-09-28:
 * `1-projects/backlog/` holds parked projects). Pure — plans only.
 *
 * - **Parking** moves a row of the page into the folder, by the move every
 *   other drop makes (`moveEntry`, which rewrites the links to it), with the
 *   move back as its Undo. Its status is left as it is: where it lives is
 *   what says it is parked.
 * - **Bringing it back** — a parked row dropped on a status group — moves it
 *   out to the page's folder and gives it that group's status, two steps
 *   taken back in reverse by one Undo.
 *
 * A page whose list has the `backlog` word and no folder keeps the word:
 * parking there is a status (`planPark`). See "Backlog as a folder" in
 * `docs/decisions/folder-lists.md`.
 */

import { groupLabel } from "../../listBlock/words";
import { baseName, parentPath } from "../../paths";
import type { FolderItem } from "../model";
import { namesUnder, uniqueEntryName } from "./taskNames";
import type { Planned, TaskRef, TaskSnapshot, TaskStep } from "./taskWrites";

/** The folder's name, in any case. */
export const BACKLOG_FOLDER = "backlog";

const quote = (label: string) => `“${label}”`;

/** Whether `item` is the Backlog folder of the page at `folder`: a folder directly in it named `backlog`. */
export function isBacklogFolder(item: Pick<FolderItem, "path" | "kind">, folder: string): boolean {
  return item.kind === "folder" && parentPath(item.path) === folder && baseName(item.path).toLowerCase() === BACKLOG_FOLDER;
}

/** The page's Backlog folder among its items, or null. */
export function backlogFolderOf(items: readonly FolderItem[], folder: string): FolderItem | null {
  return items.find((item) => isBacklogFolder(item, folder)) ?? null;
}

/** Whether `path` is parked: directly in the Backlog folder. */
export function isParked(path: string, backlog: string | null): boolean {
  return backlog !== null && parentPath(path) === backlog;
}

function allPaths(snapshot: TaskSnapshot): string[] {
  return [...snapshot.notes.map((note) => note.path), ...(snapshot.paths ?? [])];
}

/** `task`, a row of the page, moved into its Backlog folder. */
export function planParkInFolder(task: TaskRef, backlog: string, snapshot: TaskSnapshot): Planned {
  if (task.path === backlog) return { ok: false, problem: "Backlog can’t go into itself." };
  if (isParked(task.path, backlog)) return { ok: false, problem: `${quote(task.label)} is already in Backlog.` };
  if (parentPath(task.path) !== snapshot.folder) {
    return { ok: false, problem: `Only what is directly on this page goes to Backlog; ${quote(task.label)} is inside another.` };
  }
  const to = `${backlog}/${uniqueEntryName(baseName(task.path), task.kind === "note", namesUnder(backlog, allPaths(snapshot)))}`;
  return {
    ok: true,
    plan: {
      steps: [{ kind: "move", from: task.path, to }],
      path: to,
      message: `Moved ${quote(task.label)} to Backlog.`,
      touched: [snapshot.folder, backlog],
    },
  };
}

/**
 * `task`, parked in the Backlog folder, moved out to the page's folder and
 * given `status` — a drop on a status group, or between two of its rows.
 */
export function planUnpark(task: TaskRef, backlog: string, status: string, snapshot: TaskSnapshot): Planned {
  if (!isParked(task.path, backlog)) return { ok: false, problem: `${quote(task.label)} isn’t in Backlog.` };
  const { folder } = snapshot;
  const name = uniqueEntryName(baseName(task.path), task.kind === "note", namesUnder(folder, allPaths(snapshot)));
  const to = folder === "" ? name : `${folder}/${name}`;
  const steps: TaskStep[] = [{ kind: "move", from: task.path, to }];
  const word = status.trim();
  if (word !== "" && word.toLowerCase() !== task.status.toLowerCase()) {
    // A folder's status is its front note's, which moved with it.
    const target = task.kind === "folder" ? `${to}/${baseName(task.target)}` : to;
    steps.push({
      kind: "set",
      path: target,
      changes: [["status", word]],
      creates: task.creates,
      previous: [["status", task.status === "" ? null : task.status]],
    });
  }
  return {
    ok: true,
    plan: {
      steps,
      path: to,
      message: word === "" ? `Moved ${quote(task.label)} out of Backlog.` : `Moved ${quote(task.label)} out of Backlog to ${groupLabel("status", word)}.`,
      touched: [backlog, folder],
    },
  };
}
