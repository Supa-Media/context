/**
 * What the task side panel reads, before anything is drawn. Pure — no React,
 * no storage.
 *
 * The panel shows one task of the page's project beside its List or Board:
 * the task as the rows read it (`folderItems`, from the device's notes, so it
 * stays right while the listing catches up with a move), the task above it
 * when it is a subtask, its subtasks — only a top-level task has any: two
 * levels and no deeper — and the plain notes in it. See "The side panel" in
 * `docs/decisions/folder-lists.md`.
 */

import { FRONT_NOTES } from "../../../../../../mcp/src/lists/grammar.js";
import type { ListNote } from "../../listBlock/model";
import { baseName, parentPath } from "../../paths";
import { makeItTaskStatus } from "../listLayout";
import { folderItems, taskChildren, type FolderItem } from "../model";
import { groupOfStatus, type StatusList } from "../statuses";
import type { Due } from "../taskProps";
import type { TaskRef } from "../tasks/taskWrites";

/** The panel's width beside the list (the approved artboard's). */
export const PANEL_WIDTH = 430;
/** The space between the list and the panel. */
export const PANEL_GAP = 24;
/** The narrowest a List or Board is drawn beside the panel. */
const LIST_MIN = 480;
/** What a page leaves either side of what it draws, as the Board does. */
const PAGE_MARGIN = 48;

/**
 * Whether the panel fits beside the list: the page's own width once
 * measured, the window's until then. Anywhere narrower, pressing a task opens
 * its page, as it always has.
 */
export function panelFits(pageWidth: number, windowWidth: number): boolean {
  const width = pageWidth > 0 ? pageWidth : windowWidth;
  return width - 2 * PAGE_MARGIN >= LIST_MIN + PANEL_GAP + PANEL_WIDTH;
}

export interface PanelEntry {
  readonly item: FolderItem;
  /** The task a subtask sits under; null for a task of the project. */
  readonly parent: FolderItem | null;
  /** A task's subtasks, in task order; null for a subtask, which can't have any. */
  readonly subtasks: readonly FolderItem[] | null;
  /** The plain notes in it, one level down. */
  readonly notes: readonly FolderItem[];
}

function inside(path: string): string {
  return `${path}/`;
}

/** `path` as one entry of its folder, from the device's notes; null when the device has nothing there. */
function itemAt(path: string, notes: readonly ListNote[]): FolderItem | null {
  const prefix = inside(path);
  const kind = notes.some((note) => note.path.startsWith(prefix)) ? "folder" : notes.some((note) => note.path === path) ? "file" : null;
  if (kind === null) return null;
  return folderItems(parentPath(path), [{ kind, path, name: baseName(path) }], notes).items[0] ?? null;
}

/**
 * The task at `path` in the project at `folder`: a task of the project, or a
 * subtask of one. Nothing outside the project or deeper than a subtask, and
 * not the project's own front note, which speaks for the project.
 */
export function panelEntry(path: string, folder: string, notes: readonly ListNote[]): PanelEntry | null {
  if (folder !== "" && !path.startsWith(inside(folder))) return null;
  const above = parentPath(path);
  const nested = above !== folder;
  if (nested && parentPath(above) !== folder) return null;
  if (!nested && FRONT_NOTES.includes(baseName(path))) return null;
  const item = itemAt(path, notes);
  if (item === null) return null;
  const parent = nested ? itemAt(above, notes) : null;
  if (nested && parent?.kind !== "folder") return null;
  const children = item.kind === "folder" ? taskChildren(item.path, notes) : { subtasks: [], notes: [] };
  return { item, parent, subtasks: nested ? null : children.subtasks, notes: children.notes };
}

/**
 * What ticking a subtask's dot writes: a done one goes back to the list's
 * first Not started word that is not Backlog (`to do` by default) — ticked
 * off by mistake, it is work to do now, not an idea for later — and anything
 * else becomes the first Done word. Null when the list has no word to write.
 */
export function tickStatus(status: string, list: StatusList): string | null {
  const next = groupOfStatus(status, list) === "done" ? makeItTaskStatus(list) : (list.done[0] ?? "");
  return next === "" ? null : next;
}

/** Owners as written: none clears the line, one is a line, several are a list. */
export function ownersValue(owners: readonly string[]): string | string[] | null {
  if (owners.length === 0) return null;
  return owners.length === 1 ? owners[0]! : [...owners];
}

/** "Saturday, Oct 3", with the year when it is not this one. */
export function dueLong(due: Due, now: number): string {
  const date = new Date(due.year, due.month - 1, due.day);
  const weekday = date.toLocaleString("en-US", { weekday: "long" });
  const month = date.toLocaleString("en-US", { month: "short" });
  const year = new Date(now).getFullYear() === due.year ? "" : `, ${due.year}`;
  return `${weekday}, ${month} ${due.day}${year}`;
}

/**
 * The task as a plan writes to it. `shown` is where the panel now says it
 * is: a one-note task that just became a folder (its first subtask or note)
 * is written to as that folder, before the device's copy has caught up.
 */
export function taskRefOf(item: FolderItem, shown: string): TaskRef {
  const became = item.kind === "note" && shown !== item.path && shown === item.path.replace(/\.md$/i, "");
  if (!became) return { path: item.path, kind: item.kind, target: item.target, creates: item.creates, label: item.label, status: item.status };
  return { path: shown, kind: "folder", target: `${shown}/${FRONT_NOTES[0]}`, creates: false, label: item.label, status: item.status };
}
