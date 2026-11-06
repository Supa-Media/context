/**
 * One folder's rows as they are drawn, and the order a press or a drop puts
 * them in (owner, 2026-11-04; `docs/decisions/app-and-console/folder-sort.md`).
 *
 * Pure, so the rules are tested without a renderer (`__tests__/levelOrder.test.ts`):
 *
 *  - **In custom order** every row has a place, notes and folders alike, and
 *    Move up, Move down and a drop between two rows move one row among all of
 *    them.
 *  - **In any other order** the folders are drawn above the notes, Move up and
 *    Move down move a folder among the folders, and the result puts the folder
 *    in custom order with everything where it was drawn, apart from the row
 *    that moved. That is the board's "a drag switches the folder to Custom
 *    order", and it is why the whole level is always sent: the notes take
 *    their drawn places too, so nothing jumps when the setting changes.
 */

import { compareListingEntries } from "@context/shared/src/folderRoles.cjs";
import { listingSortOf, type ListingSort } from "@context/shared/src/listingSort.cjs";
import { parentPath } from "./paths";
import { listedEntries } from "./tree";
import type { FileEntry, FolderListing } from "./types";

/** The step `folderOrder.set` writes between neighbours (`ORDER_STEP` there). */
export const ROW_ORDER_STEP = 10;

type Listings = Readonly<Record<string, FolderListing | undefined>>;

export interface DrawnLevel {
  parent: string;
  /** The sort the level draws by now. */
  sort: ListingSort | null;
  /** Every listed row, in the order drawn. */
  paths: string[];
  /** The kind of each row, by path. */
  kinds: ReadonlyMap<string, FileEntry["kind"]>;
}

/** The rows of `parent` as drawn, or `null` before its listing has loaded. */
export function drawnLevel(listings: Listings, parent: string, workspaceSort: ListingSort | null): DrawnLevel | null {
  const listing = listings[parent];
  if (listing === undefined) return null;
  const sort = listingSortOf(listing, workspaceSort);
  const rows = listedEntries(listing.entries, { sort, parent });
  return { parent, sort, paths: rows.map((entry) => entry.path), kinds: new Map(rows.map((entry) => [entry.path, entry.kind])) };
}

/** The rows a row moves among with Move up and Move down: all of them in custom order, else the folders. */
function moversOf(level: DrawnLevel): string[] {
  return level.sort === "custom" ? level.paths : level.paths.filter((path) => level.kinds.get(path) === "folder");
}

/** Where a row sits among the rows it moves among, for the menu; `null` when it cannot move among them. */
export function rowPlace(listings: Listings, path: string, workspaceSort: ListingSort | null): { first: boolean; last: boolean } | null {
  const level = drawnLevel(listings, parentPath(path), workspaceSort);
  if (level === null) return null;
  const movers = moversOf(level);
  const index = movers.indexOf(path);
  if (index < 0 || movers.length < 2) return null;
  return { first: index === 0, last: index === movers.length - 1 };
}

/**
 * The level with `path` one place up or down, as the whole level in order
 * (what `folderOrder.set` is sent), or `null` when it is already at that end.
 */
export function movedLevel(level: DrawnLevel, path: string, direction: "up" | "down"): string[] | null {
  const movers = moversOf(level);
  const index = movers.indexOf(path);
  if (index < 0) return null;
  const to = direction === "up" ? index - 1 : index + 1;
  if (to < 0 || to >= movers.length) return null;
  const next = [...movers];
  next[index] = movers[to]!;
  next[to] = path;
  if (level.sort === "custom") return next;
  // Folders above notes, as drawn: the folders in their new order, then the notes where they were.
  return [...next, ...level.paths.filter((row) => level.kinds.get(row) !== "folder")];
}

/**
 * The level with `path` dropped just above or below `target` (both rows of
 * `level`, or `path` arriving from another level), as the whole level in
 * order; `null` for a drop that changes nothing.
 */
export function droppedLevel(level: DrawnLevel, path: string, target: string, zone: "above" | "below"): string[] | null {
  if (path === target) return null;
  const without = level.paths.filter((row) => row !== path);
  const at = without.indexOf(target);
  if (at < 0) return null;
  const next = [...without];
  next.splice(zone === "above" ? at : at + 1, 0, path);
  return next.length === level.paths.length && next.every((row, index) => row === level.paths[index]) ? null : next;
}

/**
 * `listing` (whose path is `parent`) as it reads once `paths` are in that
 * order and the level is in custom order: each named row takes `order` index
 * × 10, as the server writes, so the row moves now and does not move again
 * when the confirming listing arrives.
 */
export function withRowOrder(parent: string, listing: FolderListing, paths: readonly string[]): FolderListing {
  const place = new Map(paths.map((path, index) => [path, index * ROW_ORDER_STEP]));
  const entries = listing.entries.map((entry) => {
    const order = place.get(entry.path);
    return order === undefined ? entry : { ...entry, order };
  });
  entries.sort((a, b) => compareListingEntries(parent, a, b));
  return { ...listing, entries, ...(parent === "" ? {} : { sort: "custom" }) };
}

/**
 * The listings as they read once `folder` has its own setting `sort` (null:
 * none): the folder's own listing, its entry in its parent's, and every loaded
 * listing beneath it that draws by it. `inside` also takes away the setting of
 * every loaded folder beneath. The server's listings then confirm it.
 */
export function withFolderSort(listings: Listings, folder: string, sort: ListingSort | null, inside: boolean): Record<string, FolderListing | undefined> {
  const next: Record<string, FolderListing | undefined> = { ...listings };
  const prefix = folder === "" ? "" : `${folder}/`;
  for (const [path, listing] of Object.entries(listings)) {
    if (listing === undefined) continue;
    let changed = listing;
    // The folder's own entry in its parent's listing, and, with `inside`, every entry beneath it.
    if (listing.entries.some((entry) => entry.kind === "folder" && (entry.path === folder || (inside && entry.path.startsWith(prefix))))) {
      changed = {
        ...changed,
        entries: changed.entries.map((entry) => {
          if (entry.kind !== "folder") return entry;
          if (entry.path === folder) return sort === null ? withoutSort(entry) : { ...entry, sort };
          if (inside && entry.path.startsWith(prefix)) return withoutSort(entry);
          return entry;
        }),
      };
    }
    if (folder !== "" && (path === folder || path.startsWith(prefix))) {
      // The setting this listing draws by now: the folder's own for itself, and beneath it the folder's when
      // passed down (custom never is), unless a nearer folder keeps one of its own.
      const own = path === folder ? sort : nearestOwn(next, path, folder, inside);
      const drawn = path === folder ? sort : own ?? (sort === "custom" ? null : sort);
      changed = drawn === null ? withoutSort(changed) : { ...changed, sort: drawn };
    }
    next[path] = changed;
  }
  return next;
}

function withoutSort<T extends { sort?: string }>(value: T): T {
  if (value.sort === undefined) return value;
  const { sort: _gone, ...rest } = value;
  return rest as T;
}

/** The nearest setting of its own between `path` (included) and `folder` (excluded), from the loaded entries. */
function nearestOwn(listings: Listings, path: string, folder: string, inside: boolean): ListingSort | null {
  if (inside) return null;
  let at = path;
  while (at !== folder && at !== "") {
    const parent = parentPath(at);
    const entry = listings[parent]?.entries.find((row) => row.kind === "folder" && row.path === at);
    if (entry?.sort !== undefined && (at === path || entry.sort !== "custom")) return entry.sort as ListingSort;
    at = parent;
  }
  return null;
}
