/**
 * Folders and tags in a phone's search (boards 03 and 04 of the phone Home
 * artboards, approved by the owner on 2026-09-30).
 *
 * Search on a phone answers with places as well as notes: the folders whose
 * names have the letters typed, and the tags that do, each with what it holds
 * — "Folders and tags come first, since opening one is often the fastest way
 * in". "Look in" narrows the answer to one of the three.
 *
 * Built from this device's copy of the workspace (`useHomeSource`), the same
 * copy Home and a folder page count from, so a folder here says what the
 * folder's own row says. Nothing is asked of the server, and nothing here is
 * kept between calls.
 */

import { baseName, folderLabel, parentPath } from "../files/paths";
import { folderCounts } from "./folderHead";
import { countLabel } from "./homeModel";

/** What search is narrowed to. `all` is no chip picked. */
export type LookIn = "all" | "notes" | "folders" | "tags";

export interface FolderHit {
  path: string;
  label: string;
  /** Where it is: "Projects", or "Northwind" for a folder at the top. */
  where: string;
  /** "8 notes · 2 folders". */
  counts: string;
  /** `[start, end)` of the letters that matched in `label`, to bold. */
  ranges: readonly (readonly [number, number])[];
}

export interface TagHit {
  tag: string;
  /** Notes carrying it. */
  count: number;
  ranges: readonly (readonly [number, number])[];
}

export interface PlaceHits {
  folders: FolderHit[];
  tags: TagHit[];
}

/** How many of each a phone lists; more is a different question, asked by typing. */
export const PLACE_LIMIT = 20;

function inScope(path: string, scope: string | null): boolean {
  return scope === null || path.startsWith(`${scope}/`);
}

/** Where `text` holds `typed`, case aside; `null` when it does not. */
function rangeOf(text: string, typed: string): [number, number] | null {
  if (typed === "") return null;
  const at = text.toLocaleLowerCase().indexOf(typed);
  return at === -1 ? null : [at, at + typed.length];
}

/**
 * The folders and tags that match `query`, inside `scope` when search was
 * narrowed to a folder. An empty query lists every one, which is what "Look
 * in: Folders" or "Tags" shows before anything is typed.
 */
export function findPlaces({
  query,
  notes,
  folders,
  scope = null,
  rootLabel,
}: {
  query: string;
  notes: readonly { path: string; tags: readonly string[] }[];
  folders: readonly string[];
  scope?: string | null;
  rootLabel: string;
}): PlaceHits {
  const typed = query.trim().toLocaleLowerCase();
  const paths = notes.map((note) => note.path);

  const folderHits: (Omit<FolderHit, "counts"> & { starts: boolean })[] = [];
  for (const folder of new Set(folders)) {
    if (folder === "" || folder.startsWith(".") || !inScope(folder, scope)) continue;
    const label = folderLabel(baseName(folder));
    const range = rangeOf(label, typed);
    if (typed !== "" && range === null) continue;
    const parent = parentPath(folder);
    folderHits.push({
      path: folder,
      label,
      where: parent === "" ? rootLabel : folderLabel(baseName(parent)),
      ranges: range === null ? [] : [range],
      starts: range?.[0] === 0,
    });
  }
  // A name that starts with what was typed before one that only holds it, then by name.
  folderHits.sort(
    (a, b) =>
      Number(b.starts) - Number(a.starts) ||
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) ||
      a.path.localeCompare(b.path),
  );

  const counts = new Map<string, number>();
  for (const note of notes) {
    if (!inScope(note.path, scope)) continue;
    for (const tag of new Set(note.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const tagHits: TagHit[] = [];
  for (const [tag, count] of counts) {
    const range = rangeOf(tag, typed);
    if (typed !== "" && range === null) continue;
    tagHits.push({ tag, count, ranges: range === null ? [] : [range] });
  }
  tagHits.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  return {
    // Counted after the cut: counting every folder of a large workspace on each keystroke is the slow part.
    folders: folderHits.slice(0, PLACE_LIMIT).map(({ starts: _starts, ...hit }) => {
      const counts = folderCounts(paths, folders, hit.path);
      return { ...hit, counts: countLabel(counts.notes, counts.folders) };
    }),
    tags: tagHits.slice(0, PLACE_LIMIT),
  };
}

/** "7 notes", for a tag's row. */
export function taggedLabel(count: number): string {
  return count === 1 ? "1 note" : `${count} notes`;
}
