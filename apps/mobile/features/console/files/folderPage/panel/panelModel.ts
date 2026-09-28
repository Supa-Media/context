/**
 * What the side panel reads, before anything is drawn. Pure — no React, no
 * storage.
 *
 * The panel shows one row of the page beside its List or Board — a task, a
 * subtask, a plain note, a project — as the rows read it (`folderItems`,
 * from the device's notes, so it stays right while the listing catches up
 * with a move), the task above it when it is nested, a task's subtasks —
 * only a top-level task has any: two levels and no deeper — the plain notes
 * in it, and the note's words. See "The side panel" in
 * `docs/decisions/folder-lists.md`.
 */

import { FRONT_NOTES } from "../../../../../../mcp/src/lists/grammar.js";
import { splitNote } from "../../frontmatter";
import type { ListNote } from "../../listBlock/model";
import { baseName, parentPath } from "../../paths";
import { makeItTaskStatus } from "../listLayout";
import { folderItems, taskChildren, type FolderItem } from "../model";
import { groupOfStatus, type StatusList } from "../statuses";
import type { Due } from "../taskProps";
import type { TaskRef } from "../tasks/taskWrites";

/** The narrowest the panel is drawn (the approved artboard's width). */
export const PANEL_MIN = 430;
/** The widest: past this a line of the note is longer than anybody reads. */
const PANEL_MAX = 720;
/** The share of the page the panel takes between those, as Notion's side peek does. */
const PANEL_SHARE = 0.5;
/** The space between the list and the panel. */
export const PANEL_GAP = 24;
/** The narrowest a List or Board is drawn beside the panel; narrower, the panel lies over it. */
const LIST_MIN = 480;
/** What a page leaves either side of what it draws, as the Board does. */
const PAGE_MARGIN = 48;

function room(width: number): number {
  return Math.max(0, width - 2 * PAGE_MARGIN);
}

/**
 * Whether a pressed row opens beside the list at all: the page's own width
 * once measured, the window's until then. Wherever the panel itself fits it
 * opens — beside the list, or over it (`peekLayout`); on a phone
 * (`compact`, the caller's) pressing a row opens its page, as it always has.
 */
export function panelFits(pageWidth: number, windowWidth: number): boolean {
  return room(pageWidth > 0 ? pageWidth : windowWidth) >= PANEL_MIN;
}

/** About half the page, never narrower than the artboard, never wider than a line wants. */
export function panelWidthFor(pageWidth: number): number {
  const avail = room(pageWidth);
  return Math.min(avail, Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(avail * PANEL_SHARE))));
}

export interface PeekLayout {
  /** Beside the list, or lying over its right side. */
  readonly mode: "beside" | "over";
  readonly panel: number;
  /** The width of the row holding the list and the panel, and where it starts against the note's column. */
  readonly width: number;
  readonly marginLeft: number;
  /** Over: the list's own width, kept rather than squeezed. Null beside, where the list takes what is left. */
  readonly main: number | null;
  /** Over: how far the panel reaches back over the list. */
  readonly overlap: number;
}

/**
 * Where the list and the panel go on a page `pageWidth` wide whose contents
 * keep a column `columnWidth` wide. Beside, when both fit: into the room at
 * the right first, so the list stays where it was under the title, and only
 * then to the left (a Board, `wide`, takes the left as well). Otherwise the
 * list keeps its width and the panel lies over its right side, flush with the
 * page's right margin. Null before the page has been measured.
 */
export function peekLayout(pageWidth: number, columnWidth: number, wide: boolean): PeekLayout | null {
  if (pageWidth <= 0) return null;
  const avail = room(pageWidth);
  const column = Math.min(columnWidth, avail);
  const side = Math.max(0, (pageWidth - column) / 2 - PAGE_MARGIN);
  const panel = panelWidthFor(pageWidth);
  const need = panel + PANEL_GAP;
  if (avail >= LIST_MIN + need) {
    const right = Math.min(side, need);
    const left = wide ? side : Math.min(side, need - right);
    return { mode: "beside", panel, width: column + left + right, marginLeft: -left, main: null, overlap: 0 };
  }
  const width = column + side;
  return { mode: "over", panel, width, marginLeft: 0, main: column, overlap: Math.max(0, column + panel - width) };
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

/** How many folders down from the page `path` is: 1 for a row of the page. */
function depth(path: string, folder: string): number {
  return (folder === "" ? path : path.slice(folder.length + 1)).split("/").length;
}

/**
 * The row at `path` on the page of `folder`: a task, or a subtask of one, or
 * a plain note at either depth or in a subtask — "a subtask may hold notes;
 * nothing goes deeper". Nothing outside the page, no task deeper than a
 * subtask, and not a front note, which speaks for its folder.
 */
export function panelEntry(path: string, folder: string, notes: readonly ListNote[]): PanelEntry | null {
  if (folder !== "" && !path.startsWith(inside(folder))) return null;
  const level = depth(path, folder);
  if (level > 3) return null;
  const above = parentPath(path);
  const nested = level > 1;
  if (FRONT_NOTES.includes(baseName(path)) && above === folder) return null;
  const item = itemAt(path, notes);
  if (item === null) return null;
  // A third level holds only notes: the notes in a subtask.
  if (level === 3 && item.status !== "") return null;
  const parent = nested ? itemAt(above, notes) : null;
  if (nested && parent?.kind !== "folder") return null;
  const children = item.kind === "folder" ? taskChildren(item.path, notes) : { subtasks: [], notes: [] };
  return { item, parent, subtasks: nested ? null : children.subtasks, notes: children.notes };
}

/** The note whose words the panel shows: a note's own, a folder's front note, or none yet. */
export function bodyPath(item: Pick<FolderItem, "kind" | "path" | "target" | "creates">): string | null {
  if (item.kind === "note") return item.path;
  return item.creates ? null : item.target;
}

/**
 * The words as the panel shows them: without the frontmatter, which the
 * values above already say, and without a first heading that is only the
 * title drawn above them again.
 */
export function panelText(text: string, title: string): string {
  const { body } = splitNote(text);
  const heading = /^(?:[ \t]*\r?\n)*[ \t]*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(body);
  if (heading === null || plain(heading[1]!) !== plain(title)) return body;
  return body.slice(heading[0].length).replace(/^(?:[ \t]*\r?\n)+/, "");
}

/** A title as words: the direction marks a label is drawn with (`isolateForDisplay`) are not part of it. */
function plain(text: string): string {
  return text.replace(/[\u2066-\u2069]/g, "").trim();
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
