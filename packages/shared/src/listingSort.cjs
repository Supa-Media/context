/**
 * How one folder's rows are drawn: the folder's Sort setting (owner, 2026-11-04;
 * `docs/decisions/app-and-console/folder-sort.md`).
 *
 * A folder row may carry `sort`, one of `LISTING_SORTS`. A folder with none
 * takes the nearest folder above it that has one, then the workspace's own
 * (the sort button at the top of the tree), and with none anywhere draws as it
 * always has (`compareListingEntries`: folders by order, job, then name, and
 * notes by name). The setting is shared: everybody in the workspace sees the
 * same order, and only an editor changes it.
 *
 * Custom order is the one setting that is never passed down: it is what was
 * dragged in that one folder, and a folder beneath has nothing dragged in it.
 * So a folder draws by the nearest setting above it that is not custom, and
 * dragging at the top level reorders the top level and nothing else.
 *
 * - `custom`: what people dragged. Notes and folders mix, by each row's
 *   `order`. A row with no `order` yet (a new note, or one moved in) is drawn
 *   first, newest first, so it is seen and can be dragged from there.
 * - `name-asc` / `name-desc`: by name, folders above notes.
 * - `edited-*` / `created-*`: notes by that date, folders above them in the
 *   folder order a folder with no setting draws (owner: "keep above notes").
 *   A note with no date is drawn after the dated ones.
 *
 * One module, read by the app and every listing, so the sidebar, the folder
 * page and the phone never disagree about the order.
 */

"use strict";

const { compareListingEntries } = require("./folderRoles.cjs");

const LISTING_SORTS = Object.freeze([
  "custom",
  "name-asc",
  "name-desc",
  "edited-desc",
  "edited-asc",
  "created-desc",
  "created-asc",
]);

const SORT_SET = new Set(LISTING_SORTS);

/** Whether `value` is one of `LISTING_SORTS`. */
function isListingSort(value) {
  return typeof value === "string" && SORT_SET.has(value);
}

const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** By name, the way every listing breaks a tie. */
function byName(a, b) {
  return String(a.name).localeCompare(String(b.name));
}

/** `a` before `b` when `a`'s date is later (`newest`), or earlier; an undated row goes after the dated ones. */
function byDate(a, b, dateOf, newest) {
  const x = dateOf(a);
  const y = dateOf(b);
  if (x === null && y === null) return byName(a, b);
  if (x === null) return 1;
  if (y === null) return -1;
  if (x !== y) return newest ? y - x : x - y;
  return byName(a, b);
}

/** When a row arrived: its `createdAt`, else its last edit (a row copied before creation dates were kept). */
function arrivedAt(entry) {
  if (finite(entry.createdAt)) return entry.createdAt;
  return finite(entry.updatedAt) ? entry.updatedAt : null;
}

/** When a row was last edited, or null. */
function editedAt(entry) {
  return finite(entry.updatedAt) ? entry.updatedAt : null;
}

/** Custom order: unordered rows first (newest first), then by `order`, ties by name. */
function byCustomOrder(parent, a, b) {
  const x = finite(a.order);
  const y = finite(b.order);
  if (!x && !y) {
    const p = arrivedAt(a);
    const q = arrivedAt(b);
    if (p !== null && q !== null && p !== q) return q - p;
    if (p !== null && q === null) return -1;
    if (p === null && q !== null) return 1;
    return compareListingEntries(parent, a, b);
  }
  if (!x) return -1;
  if (!y) return 1;
  if (a.order !== b.order) return a.order - b.order;
  return byName(a, b);
}

/**
 * Compare two rows of the folder `parent` under `sort` (one of `LISTING_SORTS`,
 * or null/undefined for the order a folder with no setting draws).
 */
function compareSorted(parent, a, b, sort) {
  if (sort === "custom") return byCustomOrder(parent, a, b);
  if (!isListingSort(sort)) return compareListingEntries(parent, a, b);
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  if (sort === "name-asc") return byName(a, b);
  if (sort === "name-desc") return byName(b, a);
  if (a.kind === "folder") return compareListingEntries(parent, a, b);
  if (sort === "edited-desc") return byDate(a, b, editedAt, true);
  if (sort === "edited-asc") return byDate(a, b, editedAt, false);
  return byDate(a, b, arrivedAt, sort === "created-desc");
}

/** A sorted copy of `entries`, the rows of `parent`, drawn under `sort`. */
function sortEntries(parent, entries, sort) {
  return [...entries].sort((a, b) => compareSorted(parent, a, b, sort));
}

/**
 * The sort a folder draws by: its own, else the nearest one above it that is
 * not custom, else the workspace's (custom only for the top level itself).
 * `sortAt(path)` answers a folder row's own setting (or null); the root is `""`.
 */
function effectiveSort(folder, sortAt, workspaceSort) {
  let path = typeof folder === "string" ? folder.replace(/^\/+|\/+$/g, "") : "";
  const own = path === "" ? workspaceSort : sortAt(path);
  if (isListingSort(own)) return own;
  while (path !== "") {
    const cut = path.lastIndexOf("/");
    path = cut < 0 ? "" : path.slice(0, cut);
    const above = path === "" ? workspaceSort : sortAt(path);
    if (isListingSort(above) && above !== "custom") return above;
  }
  return null;
}

/**
 * The sort one listing draws by: the setting the listing carries (its folder's
 * own, or the nearest above it, as `effectiveSort` gave it from the rows), else
 * the workspace's, which a listing never carries; custom only at the top level.
 */
function listingSortOf(listing, workspaceSort) {
  if (listing !== null && listing !== undefined && isListingSort(listing.sort)) return listing.sort;
  if (!isListingSort(workspaceSort)) return null;
  const path = listing?.path ?? "";
  return workspaceSort === "custom" && path !== "" ? null : workspaceSort;
}

module.exports = { LISTING_SORTS, isListingSort, compareSorted, sortEntries, effectiveSort, listingSortOf };
