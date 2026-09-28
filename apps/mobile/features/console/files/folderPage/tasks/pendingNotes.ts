/**
 * What a task write has just done to the files, drawn before the device's
 * copy and the folder's listing catch up with it. Pure — the state lives in
 * `useTaskActions`.
 *
 * A folder page reads its rows from the listing and their properties from
 * this device's copy of the notes, and a new task, a task turned into a
 * folder or a task moved under another reaches both of those a round trip or
 * two after the write succeeded. Without this the row a person just added
 * appears a moment later, or first as a plain note with no status, and a
 * nested task is briefly in two places. So each successful create, move or
 * removal is laid over both until they say the same thing, and dropped then:
 * it is only ever an overlay of a write that already landed, never the only
 * record of one (the same rule as a chosen value in `useFolderPage.ts`).
 */

import { noteHeading, noteProperties } from "../../../../../../mcp/src/lists.js";
import type { ListNote, PropertyValue } from "../../listBlock/model";
import { baseName, parentPath } from "../../paths";
import type { ItemEntry } from "../model";

/** A path that now holds this note, or (null) holds nothing. */
export interface Pending {
  readonly notes: ReadonlyMap<string, ListNote | null>;
  /** Listing entries: what a folder now shows at a path, or null for gone. */
  readonly entries: ReadonlyMap<string, ItemEntry | null>;
}

export const NO_PENDING: Pending = { notes: new Map(), entries: new Map() };

/** The note a create wrote, as a list reads it. */
export function noteFromText(path: string, text: string, now: number): ListNote {
  const properties = noteProperties(text) as Record<string, PropertyValue>;
  return { path, properties, updatedAt: now, heading: noteHeading(text) as string | null };
}

const entryFor = (path: string, kind: "file" | "folder", now: number): ItemEntry => ({ kind, path, name: baseName(path), updatedAt: now });

/** A note written at `note.path`. */
export function pendCreate(pending: Pending, note: ListNote): Pending {
  const notes = new Map(pending.notes);
  const entries = new Map(pending.entries);
  notes.set(note.path, note);
  entries.set(note.path, entryFor(note.path, "file", note.updatedAt ?? 0));
  return { notes, entries };
}

/**
 * `from` moved to `to`: a note, or a folder and everything under it (`known`
 * is what the page draws now, overlay included).
 */
export function pendMove(pending: Pending, known: readonly ListNote[], from: string, to: string, now: number): Pending {
  const notes = new Map(pending.notes);
  const entries = new Map(pending.entries);
  const prefix = `${from}/`;
  let folder = false;
  for (const note of known) {
    if (note.path === from) {
      notes.set(from, null);
      notes.set(to, { ...note, path: to });
    } else if (note.path.startsWith(prefix)) {
      folder = true;
      notes.set(note.path, null);
      notes.set(`${to}/${note.path.slice(prefix.length)}`, { ...note, path: `${to}/${note.path.slice(prefix.length)}` });
    }
  }
  const isFolder = folder || !/\.md$/i.test(from);
  entries.set(from, null);
  entries.set(to, entryFor(to, isFolder ? "folder" : "file", now));
  // A note moved into a folder that is new to the listing (`x.md` → `x/overview.md`) makes that folder a row.
  const home = parentPath(to);
  if (home !== parentPath(from) && !entries.has(home)) entries.set(home, entryFor(home, "folder", now));
  // Taking back such a move leaves that folder empty: the row this overlay drew for it goes too.
  const left = parentPath(from);
  const drawn = pending.entries.get(left);
  if (drawn != null && drawn.kind === "folder" && ![...notes.keys()].some((path) => path.startsWith(`${left}/`) && notes.get(path) !== null) && !known.some((note) => note.path.startsWith(`${left}/`) && note.path !== from && !note.path.startsWith(`${from}/`))) {
    entries.delete(left);
  }
  return { notes, entries };
}

/** `path` (a note, or a folder and all under it) is gone. */
export function pendRemove(pending: Pending, known: readonly ListNote[], path: string): Pending {
  const notes = new Map(pending.notes);
  const entries = new Map(pending.entries);
  for (const note of known) if (note.path === path || note.path.startsWith(`${path}/`)) notes.set(note.path, null);
  notes.set(path, null);
  entries.set(path, null);
  return { notes, entries };
}

/** `notes` with what just happened laid over them. */
export function withPendingNotes(notes: readonly ListNote[], pending: Pending): readonly ListNote[] {
  if (pending.notes.size === 0) return notes;
  const out = new Map(notes.map((note) => [note.path, note]));
  for (const [path, note] of pending.notes) {
    if (note === null) out.delete(path);
    // The device's own copy wins once it has one: it holds what was really written.
    else if (!out.has(path)) out.set(path, note);
  }
  return [...out.values()];
}

/** The rows directly in `folder`, with what just happened laid over them. */
export function withPendingEntries<E extends ItemEntry>(folder: string, rows: readonly E[], pending: Pending): readonly (E | ItemEntry)[] {
  if (pending.entries.size === 0) return rows;
  const kept: (E | ItemEntry)[] = rows.filter((row) => pending.entries.get(row.path) !== null);
  const drawn = new Set(kept.map((row) => row.path));
  for (const [path, entry] of pending.entries) {
    if (entry === null || drawn.has(path) || parentPath(path) !== folder) continue;
    kept.push(entry);
  }
  return kept;
}

/**
 * `pending` without what `notes` and `rows` now agree with: a path they
 * hold that was written, or one they no longer hold that went. Unchanged
 * (the same object) when nothing settled, so a caller can tell.
 */
export function settlePending(pending: Pending, notes: readonly ListNote[] | null, rows: ReadonlyMap<string, readonly string[]>): Pending {
  let changed = false;
  const noteSet = notes === null ? null : new Set(notes.map((note) => note.path));
  const nextNotes = new Map(pending.notes);
  if (noteSet !== null) {
    for (const [path, note] of pending.notes) {
      if ((note === null) !== noteSet.has(path)) {
        nextNotes.delete(path);
        changed = true;
      }
    }
  }
  const nextEntries = new Map(pending.entries);
  for (const [path, entry] of pending.entries) {
    const listed = rows.get(parentPath(path));
    if (listed === undefined) continue;
    if ((entry === null) !== listed.includes(path)) {
      nextEntries.delete(path);
      changed = true;
    }
  }
  return changed ? { notes: nextNotes, entries: nextEntries } : pending;
}
