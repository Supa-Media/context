/**
 * Every folder a channel's days can be in, and every day file in them.
 *
 * A channel day is filed under its year and month since 2026-09-18
 * (`packages/communications/src/paths.js`), and the console lists one folder
 * at a time — `ensureListing` fetches a folder's own children and nothing
 * below them. Without this, the Inbox and the Channel view would show every
 * day written before that date and none written after it: not an empty
 * screen, which somebody would report, but a list that silently stops.
 *
 * The walk is deliberately two levels and no more. `YYYY/MM` is the shape this
 * product writes; anything deeper is a folder somebody made, and listing it
 * would turn one person's filing into fetches this view has no use for. Days
 * sitting directly in the channel folder — everything written before the
 * change — are still collected, because the folder itself is the first path
 * returned.
 */

import type { FileEntry } from "../files/types";

/** What `FileBrowser.listings` is, narrowed to what this module reads. */
type Listings = Readonly<Record<string, { entries?: readonly FileEntry[] } | undefined>>;

const YEAR = /^\d{4}$/;
const MONTH = /^\d{2}$/;

/** The last segment of a key, which is the folder's own name. */
function nameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function childFolders(entries: readonly FileEntry[] | undefined, shape: RegExp): string[] {
  return (entries ?? [])
    .filter((entry) => entry.kind === "folder" && shape.test(nameOf(entry.path)))
    .map((entry) => entry.path);
}

/**
 * The folders this view needs listed: the channel folder, its year folders,
 * and their month folders — as far as what has already been listed can say.
 *
 * It answers off the cache rather than off the bucket, so it grows by one
 * level per render: the channel folder's listing reveals the years, the years'
 * listings reveal the months. The caller calls `ensureListing` on everything
 * this returns, which is a no-op for a path already cached, so the walk
 * settles after two rounds and then costs nothing.
 */
export function dayFolderPaths(folder: string, listings: Listings): string[] {
  const paths = [folder];
  for (const year of childFolders(listings[folder]?.entries, YEAR)) {
    paths.push(year);
    for (const month of childFolders(listings[year]?.entries, MONTH)) paths.push(month);
  }
  return paths;
}

/**
 * Every file the walk can see, in one list, for the collators that turn paths
 * into days.
 *
 * Folders are left out rather than passed through: `collateChannelDays` and
 * `shapeInboxRows` both read `parseChannelDayPath`, which refuses a folder
 * anyway, and handing them entries they have to filter is how a year folder
 * ends up counted as a day somewhere.
 */
export function dayEntriesUnder(folder: string, listings: Listings): FileEntry[] {
  const files: FileEntry[] = [];
  for (const path of dayFolderPaths(folder, listings)) {
    for (const entry of listings[path]?.entries ?? []) {
      if (entry.kind === "file") files.push(entry);
    }
  }
  return files;
}
