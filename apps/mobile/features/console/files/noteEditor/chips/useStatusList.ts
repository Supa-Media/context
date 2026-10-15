import { useEffect, useState } from "react";
import type { FolderListSource, ListNote } from "../../listBlock/model";
import { folderStatuses, governingFolder, type StatusList } from "../../folderPage/statuses";

/**
 * The status words the Status chip offers for the note at `path`: its
 * folder's own list in its groups, inherited from the nearest folder above
 * that declares one, else the defaults — exactly the list that folder's page
 * groups its rows by (`folderPage/statuses.ts`), so a status picked under a
 * note's name lands in a group on the page rather than under "No group yet".
 *
 * Only the front notes of the folder and those above it are read
 * (`loadFront`), which is one small read rather than the folder's notes. A
 * source without it is asked folder by folder, as a folder page asks.
 * Answers the defaults until the read lands, and keeps them where there is
 * nothing to read.
 */
export function useStatusList(path: string | null, source: FolderListSource | undefined): StatusList {
  const folder = path === null ? "" : governingFolder(path);
  const [list, setList] = useState<StatusList>(() => folderStatuses(folder, []).list);
  useEffect(() => {
    setList(folderStatuses(folder, []).list);
    if (source === undefined || folder === "") return;
    let current = true;
    const folders = foldersFrom(folder);
    const read: Promise<readonly ListNote[]> =
      source.loadFront !== undefined
        ? source.loadFront(folders)
        : Promise.all(folders.map((at) => source.load(at, false).then((each) => each?.notes ?? []))).then((all) => all.flat());
    void read
      .then((notes) => {
        if (current) setList(folderStatuses(folder, notes).list);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [folder, source]);
  return list;
}

/** `folder` and every folder above it, nearest first; never the root, which declares no list. */
export function foldersFrom(folder: string): string[] {
  const out: string[] = [];
  let at = folder;
  while (at !== "") {
    out.push(at);
    at = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "";
  }
  return out;
}
