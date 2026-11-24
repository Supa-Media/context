/**
 * The Areas folder's page, read ahead as soon as the workspace is listed, so
 * opening it draws the seats and their readings at once, the way the Projects
 * List does (owner, 2026-11-24: "the areas page takes like half a second to 2
 * seconds to load").
 *
 * The Projects List is drawn from the listing the browser already holds; the
 * Areas page waits for its folder's notes, since a seat is its `about.md`'s
 * front matter, and then for each area's `metrics.csv`. Both are read here
 * through the same caches the page draws from (`pageCache`, `useReadings`), so
 * the page finds them there, and a read still on its way is shared, not
 * repeated. The Areas read holds every sub-area's notes and sheets too
 * (`cachedFolder`), so a sub-area opens at once as well.
 */

import type { FolderListSource } from "../../listBlock/model";
import { cachedFolder, preloadFolderPage, readFolder } from "../pageCache";
import { areaTree } from "./seat";
import { metricFolders, readReadings } from "./useReadings";

export function preloadAreas(source: FolderListSource | undefined, root: string): void {
  if (source === undefined || root === "") return;
  preloadFolderPage(source, root);
  const readBody = source.readBody;
  if (readBody === undefined) return;
  const kept = cachedFolder(source, root);
  // Shares the read `preloadFolderPage` started, where it started one.
  void (kept === undefined ? readFolder(source, root) : Promise.resolve(kept))
    .then((read) => readReadings(readBody, metricFolders(areaTree(root, root, read.notes))))
    .catch(() => {});
}
