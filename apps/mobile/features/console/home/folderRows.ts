import type { FileEntry } from "../files/types";
import { folderCounts } from "./folderHead";
import { countLabel, whenLabel, type HomeNote, type HomePin } from "./homeModel";

/**
 * What a row on a phone's folder page says beside its name (board 07 of the
 * Home artboards, approved 2026-09-30), so a folder's page reads the way Home
 * does: a subfolder with what it holds, a note with when it changed and its
 * first line, and a pinned note marked and on top.
 */
export interface PhoneRowMeta {
  /** At the right: "6 notes · 1 folder" for a folder, "Mon" for a note. */
  meta: string | null;
  /** Under the name: a note's first line. Never for a folder. */
  sub: string | null;
  pinned: boolean;
}

export type PhoneRows = (entry: FileEntry) => PhoneRowMeta;

export function phoneRows({
  notes,
  folders,
  pins,
  now,
}: {
  notes: readonly HomeNote[];
  folders: readonly string[];
  pins: readonly HomePin[];
  now: number;
}): PhoneRows {
  const byPath = new Map(notes.map((note) => [note.path, note]));
  const paths = notes.map((note) => note.path);
  const pinned = new Set(pins.map((pin) => pin.path));
  return (entry) => {
    if (entry.kind === "folder") {
      const counts = folderCounts(paths, folders, entry.path);
      return { meta: countLabel(counts.notes, counts.folders), sub: null, pinned: pinned.has(entry.path) };
    }
    const note = byPath.get(entry.path);
    const at = note?.updatedAt ?? entry.updatedAt;
    return {
      meta: at === undefined ? null : whenLabel(at, now),
      sub: note?.lede ?? null,
      pinned: pinned.has(entry.path),
    };
  };
}

/**
 * A folder page's rows in the artboard's two sections: folders, then notes,
 * with pinned notes on top of their section. Otherwise the listing's own
 * order, so a sort chosen for the tree still holds.
 */
export function phoneSections(
  rows: readonly FileEntry[],
  meta: PhoneRows,
): { folders: FileEntry[]; notes: FileEntry[] } {
  const folders = rows.filter((row) => row.kind === "folder");
  const notes = rows.filter((row) => row.kind !== "folder");
  const pinnedFirst = (list: FileEntry[]) => [
    ...list.filter((row) => meta(row).pinned),
    ...list.filter((row) => !meta(row).pinned),
  ];
  return { folders: pinnedFirst(folders), notes: pinnedFirst(notes) };
}
