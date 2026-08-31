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
 * `markerFor` is the whole of it, and it is deliberately small: **a row is
 * marked only when it differs from the folder it sits in.** A file whose
 * visibility is its folder's default is unmarked, and so now is a folder whose
 * default is its *parent's* default.
 *
 * That is not a style preference. `privacy.md` is folder defaults plus
 * exact-note exceptions, and a marker on every row in a private context draws
 * the default a dozen times while giving the one shared note no visual weight
 * at all — the opposite of what the file says. Marking only what differs makes
 * the screen a picture of the data model, so someone who has never read
 * `privacy.md` still learns how it works by using the tree.
 *
 * The folder half of that rule is new, and it is the same argument finally
 * applied consistently. A folder used to print its own default unconditionally,
 * which on a bucket laid out the standard way meant `private` beside `0-inbox`
 * and `team` beside all four PARA roots — five labels stating the two facts the
 * root already states, on the one screen with least room for them. What is left
 * is the folder somebody deliberately made different, which is exactly the row
 * worth looking at.
 *
 * Nothing about the *model* changes here, and nothing becomes unreachable: the
 * row's own menu still carries `private` / `team` / "follow the folder" for
 * every row, marked or not, and the breadcrumb over the open note still spells
 * the whole sentence out. What is dropped is a label, not a control.
 */

import { baseName, displayName, isMarkdown } from "./paths";
import type { FileEntry, FolderListing, Visibility } from "./types";

export interface TreeRow {
  kind: "file" | "folder" | "loading" | "empty";
  /** Unique per row, including the synthetic ones. */
  key: string;
  path: string;
  /**
   * The name on disk. `README.md`, `1-projects`.
   *
   * This is the identity — every operation addresses the row by `path`, and
   * this is that path's last segment. **It is not what the row draws**; see
   * `label`.
   */
  name: string;
  /**
   * What the row draws: `name` with a `.md` extension stripped.
   *
   * Separate from `name` rather than replacing it so the difference between
   * "what it is called" and "what it is named" is a fact the type carries,
   * rather than a convention a call site has to remember. See `displayName`.
   */
  label: string;
  depth: number;
  expanded: boolean;
  selected: boolean;
  /**
   * The visibility label, or `undefined` for "this row is the default".
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
 * What label, if any, this entry deserves.
 *
 * Exported and tested on its own because it is the one rule in the file
 * editor that somebody will eventually be tempted to "improve" into labelling
 * everything.
 *
 * `parentDefault` is the default of the folder the entry sits *in* — the
 * listing's own `folderDefault`. A file already carries the comparison in
 * `entry.exception`, which the server computes; a folder does not, because the
 * server has no reason to, so the comparison is made here against the listing
 * the entry arrived in. It is optional so a caller with only an entry in hand
 * still gets the old, safe answer (a folder always labelled) rather than a
 * crash or a silent `undefined`.
 */
export function markerFor(
  entry: FileEntry,
  parentDefault?: Visibility,
): Visibility | undefined {
  if (entry.kind === "folder") {
    return entry.visibility === parentDefault ? undefined : entry.visibility;
  }
  return entry.exception ? entry.visibility : undefined;
}

export interface BuildTreeOptions {
  /** Listings by folder path. `""` is the root. */
  listings: Readonly<Record<string, FolderListing | undefined>>;
  /** Folder paths the person has opened. */
  expanded: ReadonlySet<string>;
  selectedPath: string | null;
  /**
   * Reverse the name order, folders still before files.
   *
   * The tree's sort control, which the reference has and this did not. It is a
   * *view* over the listing rather than a second ordering: the server's order —
   * folders first, then files, each case-insensitively alphabetical — is the
   * only one there is, and this walks it backwards within each of the two
   * groups. Folders stay ahead of files in both directions, because "sort
   * descending" is a statement about names and not about kinds, and a tree that
   * put files above folders one press in would read as a different tree.
   */
  descending?: boolean;
}

/**
 * The entries of one folder, in the order the tree draws them.
 *
 * Exported so the sort is one implementation: the folder page lists the same
 * rows on the same data, and two orderings of one listing is the defect this
 * function exists to make impossible.
 */
export function orderedEntries(
  entries: readonly FileEntry[],
  descending = false,
): readonly FileEntry[] {
  if (!descending) return entries;
  const folders = entries.filter((entry) => entry.kind === "folder");
  const files = entries.filter((entry) => entry.kind !== "folder");
  return [...folders.reverse(), ...files.reverse()];
}

/**
 * Flatten to rows, depth-first, in listing order.
 *
 * Listing order is the server's — folders first, then files, each
 * case-insensitively alphabetical — so re-sorting here would only introduce a
 * second opinion. `descending` reverses the *presentation* of that one order;
 * see `orderedEntries`.
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
        label: "Loading…",
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
        label: "Empty",
        depth,
        expanded: false,
        selected: false,
        markerIsDefault: false,
        readOnly: true,
      });
      return;
    }

    for (const entry of orderedEntries(listing.entries, options.descending)) {
      const expanded = entry.kind === "folder" && options.expanded.has(entry.path);
      rows.push({
        kind: entry.kind,
        key: entry.path,
        path: entry.path,
        name: entry.name,
        label: displayName(entry.name),
        depth,
        expanded,
        selected: entry.path === options.selectedPath,
        // The folder this entry sits in is the one being walked, so its
        // default is the listing's — read here rather than looked up again,
        // because a second lookup is a second chance to read the wrong folder.
        marker: markerFor(entry, listing.folderDefault),
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
 * The entry for a path, from wherever the console actually knows it.
 *
 * `findEntry` above answers from the path's **parent** listing, which is the
 * right answer and not always an available one. The console fetches one folder
 * at a time, so on a cold load — a link straight to
 * `/console/@seyi?note=3-resources/books`, a restored tab, a reload with the
 * sidebar closed — the parent has never been fetched and `findEntry` answers
 * `null`. `BrowsePane` read that as "nothing is selected" and drew its empty
 * state over a folder that had, by then, loaded its own contents: the same
 * route showed different things depending on what somebody had happened to
 * expand in the tree earlier.
 *
 * So there are two fallbacks, each from something the console *does* hold:
 *
 * - **A folder's own listing.** It carries the folder's path and its default,
 *   which is everything a folder row needs.
 * - **The open note.** `EditorState` carries the visibility the `OpenNote`
 *   arrived with, for exactly this.
 *
 * One thing is honestly lost and is worth saying rather than faking: a
 * synthesised folder cannot know its *parent's* default, so it reports
 * `inherited` as its own and `exception: false`. That understates — a folder
 * somebody deliberately made different is drawn unmarked until its parent
 * loads — and the other direction would be inventing a claim about a
 * `privacy.md` rule nobody has read.
 */
export function entryAt(
  listings: Readonly<Record<string, FolderListing | undefined>>,
  path: string,
  editor?: {
    path: string | null;
    visibility: Visibility;
    inherited: Visibility;
    exception: boolean;
    readOnly: boolean;
  },
): FileEntry | null {
  const known = findEntry(listings, path);
  if (known !== null) return known;

  const own = listings[path];
  if (own !== undefined) {
    return {
      kind: "folder",
      path,
      name: baseName(path),
      visibility: own.folderDefault,
      inherited: own.folderDefault,
      exception: false,
      readOnly: false,
    };
  }

  if (editor !== undefined && editor.path === path) {
    return {
      kind: "file",
      path,
      name: baseName(path),
      visibility: editor.visibility,
      inherited: editor.inherited,
      exception: editor.exception,
      readOnly: editor.readOnly,
    };
  }

  return null;
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
  /*
    `findEntry` looks a path up in its *parent's* listing, so it answers `null`
    for a folder whose parent has never been fetched — which is the ordinary
    state after a deep link. Treating that `null` as "not a folder" sent the
    destination one level above the folder the person was looking at.

    `useFileBrowser.select` already met this and documents it: "`findEntry` is
    not enough to decide this, and that is the bug this comment used to
    describe and not prevent." A note is `.md` by construction — `createNote`
    appends it, `writeNote` refuses anything else — so an unknown path that is
    not markdown is a folder. Same rule here, so the folder on screen and the
    folder a new note lands in cannot disagree.
  */
  const entry = findEntry(listings, selectedPath);
  const isFolder = entry === null ? !isMarkdown(selectedPath) : entry.kind === "folder";
  if (isFolder) return selectedPath;
  const slash = selectedPath.lastIndexOf("/");
  return slash < 0 ? "" : selectedPath.slice(0, slash);
}
