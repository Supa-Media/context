/**
 * A folder page's children read as things with a status: which note speaks
 * for a folder, where a status is written when nothing does yet, and the
 * groups a grouped view draws. Pure — no React, no storage.
 *
 * The rules are the list block's, not a second set:
 *
 * - A folder's **front note** is the first of `FRONT_NOTES` present in it
 *   (`overview.md`, `index.md`, `README.md`), the same constant
 *   `apps/mcp/src/lists/projects.js` reads. Its frontmatter is the folder's
 *   properties. With none, a write creates `overview.md`.
 * - Status groups are the folder's status list (`statuses.ts`): Not started
 *   (No status first), In progress, Done. Any other property groups in
 *   `compareGroups` order, the unset group last.
 *
 * It differs from `rows: projects` in one deliberate way. A list block shows
 * what already *is* a project; a folder page is where something becomes one.
 * So every folder and every note in the folder is an item, and everything
 * unset sits together in one "No status" group with a way to set it, rather
 * than being left out. See "A folder page shows its children by status" in
 * `docs/decisions/folder-lists.md`.
 */

import { isDrawingPath } from "@context/drawings";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { FRONT_NOTES } from "../../../../../mcp/src/lists/grammar.js";
import { compareGroups, isDoneStatus } from "../../../../../mcp/src/lists.js";
import type { ListNote, PropertyValue } from "../listBlock/model";
import { groupLabel } from "../listBlock/words";
import { valueChoices } from "../listBlock/valueMenu";
import { baseName, displayName, folderLabel, isMarkdown } from "../paths";
import type { FileEntry } from "../types";
import { compareStatus, folderStatuses, GROUPS, type StatusList } from "./statuses";

export type FolderPageView = "files" | "list" | "board";

/** Where a new front note is written, when a folder has none. */
export const NEW_FRONT_NOTE = "overview.md";

/** What a folder or note is, as a folder page draws it. */
export interface FolderSummary {
  /** The note a property write goes to. */
  readonly target: string;
  /** `target` does not exist yet, and writing to it creates it. */
  readonly creates: boolean;
  /** The front note's `title` or first heading, contained; null for none. */
  readonly title: string | null;
  readonly properties: Readonly<Record<string, PropertyValue>>;
  /** The front note's first paragraph, when the device has read one. */
  readonly lede: string | null;
  /** The newest save anywhere inside, or null when nothing has a time. */
  readonly updatedAt: number | null;
}

export interface FolderItem extends FolderSummary {
  /** The listing entry: a folder's path, or a note's. */
  readonly path: string;
  readonly kind: "folder" | "note";
  /** What the row is called: the summary's title, else the name as the tree draws it. */
  readonly label: string;
  /** The status as written and trimmed; `""` when there is none. */
  readonly status: string;
  /** Sub-items closed out of all of them, for a folder that has any. */
  readonly progress: { readonly done: number; readonly total: number } | null;
}

export interface FolderGroup {
  /** The value, as the first item spelled it; `""` for unset. */
  readonly value: string;
  readonly label: string;
  readonly items: readonly FolderItem[];
}

function inside(folder: string): string {
  return folder === "" ? "" : `${folder}/`;
}

/**
 * The first line of the `README.md` that `createFolder` writes so an empty
 * folder exists (`renderFolderPlaceholder` in the control plane).
 */
const PLACEHOLDER_LEDE = "Folder placeholder.";

/**
 * The `README.md` a new folder is made with, still saying only that. It is
 * not a front note: a status written into it would live in a file the
 * console does not list and whose own text says to delete it, so the folder
 * gets a real `overview.md` instead. Once somebody writes in it — any
 * property, any other opening sentence — it is an ordinary front note.
 */
function isUntouchedPlaceholder(note: ListNote, name: string): boolean {
  return name === "README.md" && Object.keys(note.properties).length === 0 && (note.lede ?? "").startsWith(PLACEHOLDER_LEDE);
}

/** The front note directly in `folder`, first of `FRONT_NOTES` present. Never at the root. */
export function frontNoteOf(folder: string, notes: readonly ListNote[]): ListNote | null {
  if (folder === "") return null;
  const prefix = inside(folder);
  let found: ListNote | null = null;
  let rank = Infinity;
  for (const note of notes) {
    if (!note.path.startsWith(prefix)) continue;
    const name = note.path.slice(prefix.length);
    if (isUntouchedPlaceholder(note, name)) continue;
    const at = FRONT_NOTES.indexOf(name);
    if (at !== -1 && at < rank) {
      found = note;
      rank = at;
    }
  }
  return found;
}

function titleOf(note: ListNote | null): string | null {
  if (note === null) return null;
  const title = note.properties.title;
  if (typeof title === "string" && title.trim() !== "") return isolateForDisplay(title.trim());
  const heading = note.heading;
  if (typeof heading === "string" && heading.trim() !== "") return isolateForDisplay(heading.trim());
  return null;
}

function statusOf(properties: Readonly<Record<string, PropertyValue>>, key = "status"): string {
  const raw = properties[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value.trim() : "";
}

/** A folder as its front note describes it, with the newest save anywhere inside. */
export function summarizeFolder(folder: string, notes: readonly ListNote[]): FolderSummary {
  const front = frontNoteOf(folder, notes);
  const prefix = inside(folder);
  let newest: number | null = null;
  for (const note of notes) {
    if (!note.path.startsWith(prefix) || typeof note.updatedAt !== "number") continue;
    if (newest === null || note.updatedAt > newest) newest = note.updatedAt;
  }
  return {
    target: front?.path ?? `${prefix}${NEW_FRONT_NOTE}`,
    creates: front === null,
    title: titleOf(front),
    properties: front?.properties ?? {},
    lede: front?.lede ?? null,
    updatedAt: newest,
  };
}

/** Sub-items of a folder: notes and folders directly in it with a status, closed by the folder's Done. */
function progressOf(folder: string, notes: readonly ListNote[]): FolderItem["progress"] {
  const prefix = inside(folder);
  const statuses: string[] = [];
  const subfolders = new Set<string>();
  for (const note of notes) {
    if (!note.path.startsWith(prefix)) continue;
    const rest = note.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      if (!FRONT_NOTES.includes(rest)) statuses.push(statusOf(note.properties));
    } else subfolders.add(`${prefix}${rest.slice(0, slash)}`);
  }
  for (const sub of subfolders) statuses.push(statusOf(frontNoteOf(sub, notes)?.properties ?? {}));
  const set = statuses.filter((status) => status !== "");
  if (set.length === 0) return null;
  const { list } = folderStatuses(folder, notes);
  return { done: set.filter((status) => isDoneStatus(status, list)).length, total: set.length };
}

/**
 * The folder's children that can carry a status: every subfolder, and every
 * markdown note except the folder's own front note (which speaks for the
 * folder, not beside it). Drawings and attachments are `skipped` — they are
 * still in the Files view, and a frontmatter line is not theirs to carry.
 */
export function folderItems(
  folder: string,
  entries: readonly FileEntry[],
  notes: readonly ListNote[],
): { items: FolderItem[]; skipped: number } {
  const byPath = new Map(notes.map((note) => [note.path, note]));
  const items: FolderItem[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (entry.kind === "folder") {
      const summary = summarizeFolder(entry.path, notes);
      items.push({
        ...summary,
        path: entry.path,
        kind: "folder",
        label: summary.title ?? folderLabel(baseName(entry.path)),
        status: statusOf(summary.properties),
        progress: progressOf(entry.path, notes),
        updatedAt: summary.updatedAt ?? entry.updatedAt ?? null,
      });
      continue;
    }
    if (folder !== "" && FRONT_NOTES.includes(baseName(entry.path))) continue;
    if (!isMarkdown(entry.name) || isDrawingPath(entry.path)) {
      skipped += 1;
      continue;
    }
    const note = byPath.get(entry.path) ?? null;
    const properties = note?.properties ?? {};
    const title = titleOf(note);
    items.push({
      target: entry.path,
      creates: false,
      title,
      properties,
      lede: note?.lede ?? null,
      updatedAt: note?.updatedAt ?? entry.updatedAt ?? null,
      path: entry.path,
      kind: "note",
      label: title ?? displayName(entry.name),
      status: statusOf(properties),
      progress: null,
    });
  }
  return { items, skipped };
}

/**
 * Items grouped by one property, newest first within a group: for `status`
 * in the order of `list` (No status first), for anything else in
 * `compareGroups` order with the unset group last. Values differing only by
 * case share a group, named as the first item spelled it.
 */
export function groupFolderItems(items: readonly FolderItem[], key = "status", list?: StatusList): FolderGroup[] {
  const groups = new Map<string, { value: string; items: FolderItem[] }>();
  for (const item of items) {
    const value = key === "status" ? item.status : statusOf(item.properties, key);
    const folded = value.toLowerCase();
    const group = groups.get(folded) ?? { value, items: [] };
    group.items.push(item);
    groups.set(folded, group);
  }
  const compare = key === "status" && list !== undefined ? compareStatus(list) : compareGroups;
  return [...groups.values()]
    .sort((a, b) => compare(a.value, b.value))
    .map((group) => ({
      value: group.value,
      label: groupLabel(key, group.value),
      items: [...group.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    }));
}

/** The grouped list once anything has a status; the files otherwise. */
export function defaultFolderView(items: readonly FolderItem[]): FolderPageView {
  return items.some((item) => item.status !== "") ? "list" : "files";
}

/**
 * What a value menu offers for `key`: the values the items already use, in
 * group order — for a status, the folder's status list instead, group by
 * group (the menu draws the groups: `statusMenu`); for an owner, followed by
 * the workspace's people not already there.
 */
export function propertyChoices(
  items: readonly Pick<FolderItem, "path" | "properties">[],
  key: string,
  people: readonly string[],
  list?: StatusList,
): string[] {
  if (key === "status" && list !== undefined) return GROUPS.flatMap((group) => [...list[group]]);
  const used = valueChoices(items as readonly ListNote[], key);
  if (key !== "owner") return used;
  const seen = new Set(used.map((value) => value.toLowerCase()));
  const more = people
    .map((person) => person.trim())
    .filter((person) => person !== "" && !seen.has(person.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  return [...used, ...new Set(more)];
}

/**
 * What dropping a card on a column writes: the column's value, `null` to
 * clear it on "No status", or `undefined` when the card is already there
 * (values differing only by case are one column, as they are one group).
 */
export function dropValue(item: Pick<FolderItem, "status">, column: string): string | null | undefined {
  if (item.status.toLowerCase() === column.toLowerCase()) return undefined;
  return column === "" ? null : column;
}
