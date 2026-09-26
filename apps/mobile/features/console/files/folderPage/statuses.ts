/**
 * A folder page's statuses in their three groups — Not started, In progress,
 * Done — and every change to the folder's list of them. Pure: no React, no
 * storage. The groups and the list's format are the gateway's
 * (`apps/mcp/src/lists/statuses.js`), so a board, a list block and an agent
 * read one meaning; see "Status groups" in `docs/decisions/folder-lists.md`.
 *
 * - A **band** is one group drawn with its columns: No status (Not started
 *   only), the folder's own words in their order, then words in use that the
 *   folder never declared but that are ordinary lifecycle words (`active`).
 * - Words in use that nobody placed are the **Needs a group** band, drawn
 *   after Done, and each is offered to an owner or editor to place once.
 * - A change to the list is written to the front note that declared it, or,
 *   when nothing declared one, to this folder's own front note: the edit
 *   goes where the list lives, so a subfolder never quietly forks its
 *   parent's list.
 */

import {
  STATUS_GROUPS,
  STATUS_GROUP_LABELS,
  compareStatuses,
  isDeclaredStatus,
  resolveStatusList,
  statusGroupOf,
  statusKey,
  statusListProblem,
  withStatus,
} from "../../../../../mcp/src/lists.js";
import { FRONT_NOTES } from "../../../../../mcp/src/lists/grammar.js";
import type { ListNote } from "../listBlock/model";
import { groupLabel } from "../listBlock/words";
import type { FolderGroup, FolderItem } from "./model";

export type StatusGroup = "not-started" | "in-progress" | "done";
export type StatusList = Readonly<Record<StatusGroup, readonly string[]>>;

export const GROUPS = STATUS_GROUPS as readonly StatusGroup[];
export const GROUP_LABELS = STATUS_GROUP_LABELS as Readonly<Record<StatusGroup, string>>;

/** The list that applies in a folder, and where it is written down. */
export interface FolderStatuses {
  readonly list: StatusList;
  /** The folder whose front note declares it; null for the defaults. */
  readonly from: string | null;
  /** That front note; null for the defaults. */
  readonly note: string | null;
}

export function folderStatuses(folder: string, notes: readonly ListNote[]): FolderStatuses {
  return resolveStatusList(folder, notes) as FolderStatuses;
}

/** The group a status is in, or null for a word nobody placed. `""` is Not started. */
export function groupOfStatus(status: string, list: StatusList): StatusGroup | null {
  return statusGroupOf(status, list) as StatusGroup | null;
}

export function compareStatus(list: StatusList): (a: string, b: string) => number {
  return (a, b) => compareStatuses(a, b, list);
}

/** A band on the board: one group's columns, or (group null) the words nobody placed. */
export interface StatusBand {
  readonly group: StatusGroup | null;
  readonly label: string;
  readonly columns: readonly FolderGroup[];
}

/**
 * The board's bands, in order. Every status the folder's list holds is a
 * column even while empty, so there is always somewhere to drop a card; a
 * word in use is a column where its group puts it. "No status" leads Not
 * started for somebody who can move cards (dropping there clears a status),
 * and for a reader only when something is in it. A band with no columns is
 * left out; so is Needs a group when nothing needs one.
 */
export function statusBands(groups: readonly FolderGroup[], list: StatusList, canMove: boolean): StatusBand[] {
  const byWord = new Map(groups.map((group) => [group.value.toLowerCase(), group]));
  const placed = new Set<string>();
  const column = (value: string): FolderGroup => {
    placed.add(value.toLowerCase());
    return byWord.get(value.toLowerCase()) ?? { value, label: groupLabel("status", value), items: [] };
  };
  const bands: StatusBand[] = [];
  for (const group of GROUPS) {
    const columns: FolderGroup[] = [];
    if (group === "not-started" && (canMove || byWord.has(""))) columns.push(column(""));
    for (const word of list[group]) if (!placed.has(word.toLowerCase())) columns.push(column(word));
    const inUse = groups
      .filter((each) => each.value !== "" && !placed.has(each.value.toLowerCase()) && groupOfStatus(each.value, list) === group)
      .sort((a, b) => compareStatuses(a.value, b.value, list));
    for (const each of inUse) columns.push(column(each.value));
    if (columns.length > 0) bands.push({ group, label: GROUP_LABELS[group], columns });
  }
  const unplaced = groups.filter((each) => !placed.has(each.value.toLowerCase())).sort((a, b) => compareStatuses(a.value, b.value, list));
  if (unplaced.length > 0) bands.push({ group: null, label: "Needs a group", columns: unplaced });
  return bands;
}

/**
 * The List view's bands: the same groups, only what has something in it,
 * and no empty columns — a list is read, not dropped on.
 */
export function listBands(groups: readonly FolderGroup[], list: StatusList): StatusBand[] {
  return statusBands(groups, list, false)
    .map((band) => ({ ...band, columns: band.columns.filter((column) => column.items.length > 0) }))
    .filter((band) => band.columns.length > 0);
}

/** One section of the status menu: a group's name and the words it offers. */
export interface StatusMenuSection {
  readonly group: StatusGroup;
  readonly label: string;
  /** `""` is No status. */
  readonly words: readonly string[];
}

/** What the status menu offers: each group's statuses, No status first. */
export function statusMenu(list: StatusList): StatusMenuSection[] {
  return GROUPS.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    words: group === "not-started" ? ["", ...list[group]] : [...list[group]],
  }));
}

/** A word in use that the folder's list does not hold. */
export interface UndeclaredStatus {
  /** As the first item spelled it. */
  readonly word: string;
  readonly count: number;
  /** The group an ordinary lifecycle word belongs to; null when nobody placed it. */
  readonly group: StatusGroup | null;
  /** The status a merge would move these to: the first of `group` in the list. */
  readonly mergeInto: string | null;
}

/**
 * Words the folder's items use that its list does not hold, most used first.
 * An ordinary word (`active`) comes with its group and the status it would
 * merge into; an unknown one (`exploration`) with neither, to be placed.
 */
export function undeclaredStatuses(items: readonly Pick<FolderItem, "status">[], list: StatusList): UndeclaredStatus[] {
  const found = new Map<string, { word: string; count: number }>();
  for (const item of items) {
    if (item.status === "" || isDeclaredStatus(item.status, list)) continue;
    const folded = item.status.toLowerCase();
    const seen = found.get(folded) ?? { word: item.status, count: 0 };
    seen.count += 1;
    found.set(folded, seen);
  }
  return [...found.values()]
    .sort((a, b) => b.count - a.count || compareStatuses(a.word, b.word, list))
    .map(({ word, count }) => {
      const group = groupOfStatus(word, list);
      const mergeInto = group === null ? null : (list[group][0] ?? null);
      return { word, count, group, mergeInto };
    });
}

/* ------------------------------- changing it ------------------------------- */

/** A frontmatter change: key and the list written, one per group. */
export type StatusListWrite = readonly (readonly [string, readonly string[]])[];

/** The three keys that write `list`. */
export function statusListWrite(list: StatusList): StatusListWrite {
  return GROUPS.map((group) => [statusKey(group), [...list[group]]] as const);
}

/** Why a list cannot be saved, as a sentence; null when it can. */
export function statusListIssue(list: StatusList): string | null {
  const problem = statusListProblem(list) as string | null;
  return problem === null ? null : problem.charAt(0).toUpperCase() + problem.slice(1) + ".";
}

/** `list` with `word` placed in `group` at `index` (the end by default), out of any other group. */
export function placeStatus(list: StatusList, word: string, group: StatusGroup, index?: number): StatusList {
  return withStatus(list, word, group, index) as StatusList;
}

/** `list` without `word`. */
export function removeStatus(list: StatusList, word: string): StatusList {
  return withStatus(list, word, "") as StatusList;
}

/** `list` with `from` renamed to `to`, in place. */
export function renameStatus(list: StatusList, from: string, to: string): StatusList {
  const group = GROUPS.find((each) => list[each].some((word) => word.toLowerCase() === from.toLowerCase()));
  if (group === undefined) return list;
  const at = list[group].findIndex((word) => word.toLowerCase() === from.toLowerCase());
  return placeStatus(removeStatus(list, from), to, group, at);
}

/** `list` with `word` one place earlier (`-1`) or later (`1`) in its group. */
export function moveStatus(list: StatusList, word: string, by: -1 | 1): StatusList {
  const group = GROUPS.find((each) => list[each].some((item) => item.toLowerCase() === word.toLowerCase()));
  if (group === undefined) return list;
  const at = list[group].findIndex((item) => item.toLowerCase() === word.toLowerCase());
  const to = at + by;
  if (to < 0 || to >= list[group].length) return list;
  return placeStatus(list, list[group][at], group, to);
}

/**
 * Where a status goes when its word is deleted: the first other status in
 * its group, or No status (`null`) in Not started.
 */
export function replacementFor(list: StatusList, word: string): string | null {
  const group = GROUPS.find((each) => list[each].some((item) => item.toLowerCase() === word.toLowerCase()));
  if (group === undefined) return null;
  return list[group].find((item) => item.toLowerCase() !== word.toLowerCase()) ?? null;
}

/**
 * The folder whose list governs a note's `status`: a front note's status is
 * its folder's, which its parent's list describes; any other note is
 * described by the list of the folder it is in.
 */
export function governingFolder(path: string): string {
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  if (FRONT_NOTES.includes(name)) parts.pop();
  return parts.join("/");
}

/**
 * The notes a rename or delete of `word` in the list declared at `from`
 * rewrites: every note using it whose status that list describes (not one
 * whose folder declares its own), inside `within` — the folder the list is
 * written to. `from` null means the defaults, which a first edit turns into
 * `within`'s own list.
 */
export function notesUsing(word: string, from: string | null, within: string, notes: readonly ListNote[]): string[] {
  const folded = word.trim().toLowerCase();
  const paths: string[] = [];
  for (const note of notes) {
    const governing = governingFolder(note.path);
    if (governing !== within && !governing.startsWith(`${within}/`)) continue;
    const raw = note.properties.status;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || value.trim().toLowerCase() !== folded) continue;
    if (folderStatuses(governing, notes).from !== from) continue;
    paths.push(note.path);
  }
  return paths.sort();
}
