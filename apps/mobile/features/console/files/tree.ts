/**
 * Turning folder listings into the rows the tree draws.
 *
 * The console fetches one folder at a time — the same way the tree expands —
 * and this flattens whatever has arrived into an ordered list of rows. A
 * folder that is expanded but whose listing has not landed yet gets a
 * `loading` row rather than silently rendering as empty, because "this folder
 * is empty" and "this folder has not loaded" are very different sentences to
 * put in front of someone looking at their own notes.
 *
 * ## The visibility marker rule
 *
 * `markerFor` is the whole of it, and it is deliberately small:
 *
 *  - a **file** is marked only when it *differs from its folder's default*;
 *  - a **folder** always shows its own default.
 *
 * That is not a style preference. `privacy.md` is folder defaults plus
 * exact-note exceptions, and a marker on every file in a private folder draws
 * the default five times while giving the one shared note no visual weight at
 * all — the opposite of what the file says. Marking only exceptions makes the
 * screen a picture of the data model, so someone who has never read
 * `privacy.md` still learns how it works by using the tree.
 */

import type { FileEntry, FolderListing, Visibility } from "./types";

export interface TreeRow {
  kind: "file" | "folder" | "loading" | "empty";
  /** Unique per row, including the synthetic ones. */
  key: string;
  path: string;
  name: string;
  depth: number;
  expanded: boolean;
  selected: boolean;
  /**
   * The visibility chip, or `undefined` for "nothing worth saying here".
   * See the module comment.
   */
  marker?: Visibility;
  /** True on a folder row: the marker is its default, not an exception. */
  markerIsDefault: boolean;
  readOnly: boolean;
  size?: number;
  updatedAt?: number;
}

/**
 * What chip, if any, this entry deserves.
 *
 * Exported and tested on its own because it is the one rule in the file
 * editor that somebody will eventually be tempted to "improve" into labelling
 * everything.
 */
export function markerFor(entry: FileEntry): Visibility | undefined {
  if (entry.kind === "folder") return entry.visibility;
  return entry.exception ? entry.visibility : undefined;
}

export interface BuildTreeOptions {
  /** Listings by folder path. `""` is the root. */
  listings: Readonly<Record<string, FolderListing | undefined>>;
  /** Folder paths the person has opened. */
  expanded: ReadonlySet<string>;
  selectedPath: string | null;
}

/**
 * Flatten to rows, depth-first, in listing order.
 *
 * Listing order is the server's — folders first, then files, each
 * case-insensitively alphabetical — so re-sorting here would only introduce a
 * second opinion.
 */
export function buildTreeRows(options: BuildTreeOptions): TreeRow[] {
  const rows: TreeRow[] = [];

  function walk(folder: string, depth: number): void {
    const listing = options.listings[folder];
    if (listing === undefined) {
      rows.push({
        kind: "loading",
        key: `${folder}::loading`,
        path: folder,
        name: "Loading…",
        depth,
        expanded: false,
        selected: false,
        markerIsDefault: false,
        readOnly: true,
      });
      return;
    }
    if (listing.entries.length === 0) {
      rows.push({
        kind: "empty",
        key: `${folder}::empty`,
        path: folder,
        name: "Empty",
        depth,
        expanded: false,
        selected: false,
        markerIsDefault: false,
        readOnly: true,
      });
      return;
    }

    for (const entry of listing.entries) {
      const expanded = entry.kind === "folder" && options.expanded.has(entry.path);
      rows.push({
        kind: entry.kind,
        key: entry.path,
        path: entry.path,
        name: entry.name,
        depth,
        expanded,
        selected: entry.path === options.selectedPath,
        marker: markerFor(entry),
        markerIsDefault: entry.kind === "folder",
        readOnly: entry.readOnly,
        size: entry.size,
        updatedAt: entry.updatedAt,
      });
      if (expanded) walk(entry.path, depth + 1);
    }
  }

  walk("", 0);
  return rows;
}

/**
 * The names already used in a folder, so a rename, move or paste can be
 * refused before it is attempted.
 */
export function namesIn(
  listings: Readonly<Record<string, FolderListing | undefined>>,
  folder: string,
): Set<string> {
  return new Set((listings[folder]?.entries ?? []).map((entry) => entry.name));
}

/** Find an entry across every loaded listing. */
export function findEntry(
  listings: Readonly<Record<string, FolderListing | undefined>>,
  path: string,
): FileEntry | null {
  const listing = listings[path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""];
  return listing?.entries.find((entry) => entry.path === path) ?? null;
}

/**
 * Which folders a change invalidates.
 *
 * Every operation touches at most two folders — where something left and where
 * it arrived — and a visibility change touches the folder it happened in.
 * Refetching only those keeps an expanded tree from collapsing and reloading
 * itself every time somebody renames a file.
 *
 * A folder-level change is the exception: a folder's default cascades to every
 * note under it that has no exception of its own, so everything currently
 * loaded beneath it is stale.
 */
export function foldersToRefresh(
  paths: readonly string[],
  options: { cascadeFrom?: string; loaded?: readonly string[] } = {},
): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    folders.add(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  }
  if (options.cascadeFrom !== undefined) {
    const root = options.cascadeFrom;
    folders.add(root);
    folders.add(root.includes("/") ? root.slice(0, root.lastIndexOf("/")) : "");
    for (const loaded of options.loaded ?? []) {
      if (loaded === root || loaded.startsWith(`${root}/`)) folders.add(loaded);
    }
  }
  return [...folders].sort();
}

/**
 * Which folder a new note or folder should be created in.
 *
 * Written once because it was written twice and the copies disagreed. The
 * explorer's toolbar had it right — a selected *folder* is the destination,
 * anything else means its parent — while the phone's toolbar used
 * `parentPath(selectedPath)` unconditionally. Since selecting a folder in the
 * tree also expands it, `selectedPath` is routinely a folder, so tapping
 * `1-projects` and then `+` on a phone created the note at the **root**.
 *
 * `null` means nothing is selected, which is the root — and the root is a
 * legitimate destination, so it is `""` rather than a refusal.
 */
export function targetFolder(
  listings: Readonly<Record<string, FolderListing | undefined>>,
  selectedPath: string | null,
): string {
  if (selectedPath === null) return "";
  const entry = findEntry(listings, selectedPath);
  if (entry?.kind === "folder") return selectedPath;
  const slash = selectedPath.lastIndexOf("/");
  return slash < 0 ? "" : selectedPath.slice(0, slash);
}
