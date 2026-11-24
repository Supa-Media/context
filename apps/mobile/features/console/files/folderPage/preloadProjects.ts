/**
 * The Projects folder and every project's page, read ahead as soon as the
 * workspace is listed, so opening a project draws its page, description
 * included, at once, as the Areas page does (`areas/preloadAreas.ts`; owner,
 * 2026-11-24: "you didnt work on making the project details load instantly as
 * well?" and "the descriptions on pages still take their time to load").
 *
 * A folder's page waits for three things (`folderPageReady`): its notes, its
 * front notes and the words of its `about.md`, the description under its
 * title. A read of a folder above holds the first two for every folder under
 * it (`cachedFolder`, `cachedFront`); the words are read here, by name, for
 * each folder under the root that has an `about.md` (`preloadWords`). All of it
 * goes through the caches the page draws from, so a read still on its way is
 * shared, not repeated.
 */

import type { FolderListSource } from "../listBlock/model";
import { aboutOf, cachedBody, cachedFolder, cachedFront, preloadFolderPage, readAbout, readFolder, type FolderRead } from "./pageCache";

/** Folders whose words one preload reads, at most: the rest are read when opened, as before. */
export const PRELOAD_WORDS = 60;
/** Words read at once. */
const WORDS_AT_ONCE = 6;

/** Every folder under `root` that the read names a note in, nearest first. */
export function foldersUnder(root: string, paths: readonly string[]): string[] {
  const prefix = `${root}/`;
  const found = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const parts = path.slice(prefix.length).split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth += 1) found.add(`${root}/${parts.slice(0, depth).join("/")}`);
  }
  return [...found].sort((a, b) => a.split("/").length - b.split("/").length);
}

/** Read the description of every folder under `root` that `read` (the root's read) shows has one. */
export async function preloadWords(source: FolderListSource, root: string, read: FolderRead): Promise<void> {
  if (source.readBody === undefined) return;
  const abouts: string[] = [];
  for (const folder of foldersUnder(root, read.notes.map((note) => note.path))) {
    const front = cachedFront(source, folder);
    const about = front === undefined ? null : aboutOf(folder, front);
    if (about !== null && cachedBody(source, about) === undefined) abouts.push(about);
    if (abouts.length >= PRELOAD_WORDS) break;
  }
  for (let at = 0; at < abouts.length; at += WORDS_AT_ONCE) {
    await Promise.all(abouts.slice(at, at + WORDS_AT_ONCE).map((about) => readAbout(source, about)));
  }
}

/** The root's own read, shared with the one `preloadFolderPage` started. */
export function readAhead(source: FolderListSource, root: string): Promise<FolderRead> {
  preloadFolderPage(source, root);
  const kept = cachedFolder(source, root);
  return kept === undefined ? readFolder(source, root) : Promise.resolve(kept);
}

export function preloadProjects(source: FolderListSource | undefined, root: string): void {
  if (source === undefined || root === "") return;
  void readAhead(source, root)
    .then((read) => preloadWords(source, root, read))
    .catch(() => {});
}
