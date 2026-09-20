/**
 * What the tree looks like the instant a structural change is made, rather
 * than one round trip later.
 *
 * ## The complaint
 *
 * Renaming a folder, or dragging one somewhere else, used to be: disable the
 * toolbar, await `moveEntry`, then await a `listFiles` for each folder the
 * change touched, and only then repaint. Two serial network waits before a
 * single character on screen changes. On a phone on a train that is seconds of
 * a picture that is now wrong, with the row still sitting where it was — and
 * the natural reading of that is that the drag did not take, so people do it
 * again.
 *
 * It was worse than slow for a *folder*. Listings are keyed by path, so every
 * listing under the moved folder was still filed under a path the bucket no
 * longer had, and `expanded` still named those paths too. The refresh reloaded
 * the two parents and nothing else, so the subtree you had open collapsed and
 * had to be re-expanded a folder at a time, each one its own request.
 *
 * ## What this is
 *
 * The pure half of the fix: given the listings on screen it returns the
 * listings after the operation, with the moved folder's whole subtree re-keyed
 * and carried across. The hook paints that immediately, sends the mutation,
 * and lets the refresh that follows overwrite it with the server's answer.
 *
 * Pure, and free of React, react-native and the DOM, for the reason every
 * module in this folder is: the console's Jest suite runs in plain node with
 * no renderer, and "the subtree travels with the folder" is a rule worth
 * holding in a test rather than inferring from a screenshot.
 *
 * ## Nothing here invents a fact
 *
 * Three restraints, and each is the difference between a fast console and one
 * that lies:
 *
 *  - **A folder nobody has read is left alone.** If the destination's listing
 *    has never been fetched, the moved row is not put anywhere: writing a
 *    one-entry listing for it would draw a folder that appears to hold exactly
 *    one note. Absent is true; a listing of one is not.
 *  - **A new folder inherits its parent's default**, exactly as the server
 *    gives a new key with no exception of its own — and `private` when the
 *    parent is unknown, so nothing drawn from here ever claims to be shared.
 *    Same rule as `offline/overlay.ts`'s `fileEntry`, for the same reason.
 *  - **Visibility is not recomputed.** A subtree carried into a folder with a
 *    different default keeps the visibility the server last stated for it,
 *    which is stale until the refresh lands. That is not a new staleness — it
 *    is the same data the console was already showing for the whole of the
 *    round trip this removes, for a shorter time and at the right path. What
 *    makes it correct rather than merely shorter is the caller: a folder move
 *    refreshes its whole re-keyed subtree (`cascadeFrom`), and `refresh`
 *    commits each folder as it arrives, so the marks settle folder by folder
 *    instead of all at once at the end.
 *
 * ## The inverse is the same function
 *
 * A move's undo is the move with its ends swapped — which is what
 * `moveEntry` itself is, and what `useFileBrowser`'s rollback runs when the
 * mutation is refused. There is no separate "restore the snapshot" path,
 * because a snapshot taken before the mutation would also undo whatever
 * arrived while it was in flight.
 */

import type { FileEntry, FolderListing, Visibility } from "./types";

type Listings = Readonly<Record<string, FolderListing | undefined>>;
type MutableListings = Record<string, FolderListing | undefined>;

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The server's order, and deliberately the same three lines as
 * `offline/overlay.ts`: folders first, then `localeCompare` on the name. Two
 * surfaces that disagreed about where a row lands would be a row that jumps
 * when the refresh arrives.
 */
function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Whether `path` is `root` itself or sits underneath it. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Where a path ends up once `from` has become `to`.
 *
 * The slash in `startsWith` is the whole of it: `1-projects/foobar` is not
 * under `1-projects/foo`, and a bare prefix test would have moved it.
 */
export function rekeyPath(path: string | null, from: string, to: string): string | null {
  if (path === null) return null;
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return path;
}

/** `rekeyPath` over a set — the expanded folders, and the tabs. */
export function rekeyPaths(
  paths: Iterable<string>,
  from: string,
  to: string,
): ReadonlySet<string> {
  const next = new Set<string>();
  for (const path of paths) next.add(rekeyPath(path, from, to) as string);
  return next;
}

/** Every loaded folder that travels with a move of `from`. */
export function subtreeOf(listings: Listings, from: string): string[] {
  return Object.keys(listings).filter((key) => isUnder(key, from));
}

/**
 * The listings after `from` has become `to`.
 *
 * Handles a note and a folder identically — a rename, a drag into a sibling
 * folder and a "Move to…" are one operation with different arguments, and this
 * having a second case for any of them is how they come to behave differently.
 */
export function applyMove(listings: Listings, from: string, to: string): MutableListings {
  const next: MutableListings = { ...listings };
  const sourceParent = parentOf(from);
  const destinationParent = parentOf(to);

  // 1. Take the row out of the folder it was listed in.
  let moved: FileEntry | undefined;
  const source = next[sourceParent];
  if (source !== undefined) {
    const index = source.entries.findIndex((one) => one.path === from);
    if (index !== -1) {
      moved = source.entries[index];
      next[sourceParent] = {
        ...source,
        entries: source.entries.filter((_, at) => at !== index),
      };
    }
  }

  // 2. Carry the subtree across, re-keyed. A note has none and this is a
  //    no-op for it; a folder's is what stops the tree collapsing.
  for (const key of subtreeOf(listings, from)) {
    const listing = listings[key];
    delete next[key];
    if (listing === undefined) continue;
    const at = rekeyPath(key, from, to) as string;
    next[at] = {
      ...listing,
      path: at,
      entries: listing.entries.map((one) => ({
        ...one,
        path: rekeyPath(one.path, from, to) as string,
      })),
    };
  }

  // 3. Put the row in its new folder — if that folder has actually been read.
  //    See the header: a listing invented here would draw a folder as holding
  //    one note.
  const destination = next[destinationParent];
  if (moved !== undefined && destination !== undefined) {
    if (!destination.entries.some((one) => one.path === to)) {
      const arrival: FileEntry = { ...moved, path: to, name: baseNameOf(to) };
      next[destinationParent] = {
        ...destination,
        entries: [...destination.entries, arrival].sort(compareEntries),
      };
    }
  }

  return next;
}

/**
 * A new folder, drawn before the `createDirectory` that makes it real.
 *
 * It gets its own empty listing as well as its row, so opening it straight
 * away shows an empty folder rather than a spinner over a read that has
 * nothing to find. Same pair, and the same reasoning, as the `folder` arm of
 * `offline/overlay.ts`.
 */
export function applyFolderCreate(listings: Listings, path: string): MutableListings {
  const next: MutableListings = { ...listings };
  const parentKey = parentOf(path);
  const parent = next[parentKey];
  const inherited: Visibility = parent?.folderDefault ?? "private";

  if (parent !== undefined && !parent.entries.some((one) => one.path === path)) {
    const row: FileEntry = {
      kind: "folder",
      path,
      name: baseNameOf(path),
      visibility: inherited,
      inherited,
      exception: false,
      readOnly: false,
    };
    next[parentKey] = { ...parent, entries: [...parent.entries, row].sort(compareEntries) };
  }

  if (next[path] === undefined) {
    next[path] = {
      path,
      folderDefault: inherited,
      entries: [],
      truncated: false,
      manifestUsable: parent?.manifestUsable ?? true,
    };
  }
  return next;
}

/** The inverse of `applyFolderCreate`, for a `createDirectory` that failed. */
export function undoFolderCreate(listings: Listings, path: string): MutableListings {
  const next: MutableListings = { ...listings };
  const parentKey = parentOf(path);
  const parent = next[parentKey];
  if (parent !== undefined) {
    next[parentKey] = {
      ...parent,
      entries: parent.entries.filter((one) => one.path !== path),
    };
  }
  for (const key of subtreeOf(listings, path)) delete next[key];
  return next;
}
