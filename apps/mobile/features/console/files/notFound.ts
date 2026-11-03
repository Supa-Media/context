/**
 * A note that was asked for and is not there (`NotFoundNote`).
 *
 * The control plane answers `FILE_NOT_FOUND` alike for a note that does not
 * exist and one the caller may not see, so nothing here may tell the two
 * apart. Everything this module offers instead (the nearest folder, notes
 * with a similar name, the words to search for) is worked out from listings
 * the viewer has already been shown, which are `canSee`-filtered, and from
 * the address that was asked for. Nothing is fetched about the asked-for path
 * itself, and a folder the viewer cannot see is treated exactly like one that
 * is not there.
 */

import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { isMarkdown, parentPath, withoutSortPrefix } from "./paths";
import type { FileEntry, FolderListing } from "./types";

export const NOT_FOUND_TITLE = "We can't find this note";
export const NOT_FOUND_BODY = "It may have been moved, renamed or deleted, or it may not be shared with you.";
export const SIMILAR_HEADING = "Similar notes nearby";
export const BACK_LABEL = "Go back";
export const searchLabel = (words: string): string => `Search for “${isolateForDisplay(words)}”`;
export const openFolderLabel = (name: string): string => `Open ${name}`;

/**
 * Whether the not-found page is what the pane shows: the path refused is the
 * one selected, or the one the address names before anything is selected.
 */
export function notFoundOnScreen(
  notFound: string | null | undefined,
  selectedPath: string | null,
  pendingNote: string | null | undefined,
): boolean {
  return notFound != null && notFound === (selectedPath ?? pendingNote ?? null);
}

/**
 * The path the console is standing on, for what the bottom bar searches and
 * where its new note goes: the selection, unless the selection is a note that
 * is not there, when it is the nearest folder the page offers instead, so the
 * bar never names a folder that does not exist.
 */
export function standingAt(
  selectedPath: string | null,
  notFound: string | null | undefined,
  listings: Listings,
): string | null {
  if (selectedPath === null || notFound !== selectedPath) return selectedPath;
  const nearest = nearestFolder(selectedPath, listings);
  return nearest === "" ? null : nearest;
}

/** At most this many similar notes are offered. */
export const MAX_SUGGESTIONS = 3;

type Listings = Readonly<Record<string, FolderListing | undefined>>;

/** The last segment's name without `.md`, `.page` or a sort prefix: what a person called it. */
export function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  let stem = withoutSortPrefix(base);
  if (isMarkdown(stem)) stem = stem.slice(0, -3);
  if (stem.endsWith(".page")) stem = stem.slice(0, -5);
  return stem;
}

function wordsOf(stem: string): string[] {
  return stem
    .toLowerCase()
    .split(/[\s._-]+/)
    .filter((word) => word !== "");
}

/** The words to search for: "last-7-days.page.md" → "last 7 days". */
export function searchWords(path: string): string {
  return wordsOf(stemOf(path)).join(" ");
}

/**
 * The deepest folder on the way to `path` that the viewer can see: walked
 * down from the root, one step at a time, through folders their own listings
 * name. A folder that is missing and one that is hidden both end the walk at
 * their parent, so where it stops says nothing about which it was. `""` is
 * the workspace's root.
 */
export function nearestFolder(path: string, listings: Listings): string {
  const segments = parentPath(path).split("/").filter((segment) => segment !== "");
  let at = "";
  for (const segment of segments) {
    const next = at === "" ? segment : `${at}/${segment}`;
    const listed = listings[at]?.entries.some((entry) => entry.kind === "folder" && entry.path === next) === true;
    if (!listed) break;
    at = next;
  }
  return at;
}

/** Levenshtein distance, stopping early once past `limit`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
      best = Math.min(best, row[j]);
    }
    if (best > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length];
}

/** How alike two names are, or null when they are not alike enough to offer. */
function likeness(asked: string, candidate: string): number | null {
  const a = wordsOf(asked);
  const b = wordsOf(candidate);
  let leading = 0;
  while (leading < a.length && leading < b.length && a[leading] === b[leading]) leading += 1;
  const theirs = new Set(b);
  const shared = [...new Set(a)].filter((word) => theirs.has(word));
  const close = distance(a.join(" "), b.join(" "), 2) <= 2;
  // A shared "7" or "to" is not a likeness; a shared word of three letters or a near-typo is.
  if (!close && !shared.some((word) => word.length >= 3)) return null;
  return leading * 10 + shared.length * 3 + (close ? 5 : 0);
}

/**
 * Notes in `folder`'s listing whose names are like the one asked for, best
 * first, ties to the most recently edited. Only the folder's own notes, not
 * its subfolders': the listing the tree already loaded, with no new request.
 */
export function similarNotes(path: string, folder: string, listings: Listings): FileEntry[] {
  const asked = stemOf(path);
  const scored: { entry: FileEntry; score: number }[] = [];
  for (const entry of listings[folder]?.entries ?? []) {
    if (entry.kind !== "file" || entry.path === path || !isMarkdown(entry.name)) continue;
    const score = likeness(asked, stemOf(entry.path));
    if (score !== null) scored.push({ entry, score });
  }
  return scored
    .sort((x, y) => y.score - x.score || (y.entry.updatedAt ?? 0) - (x.entry.updatedAt ?? 0))
    .slice(0, MAX_SUGGESTIONS)
    .map((item) => item.entry);
}
