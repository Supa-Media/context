/**
 * The rows of the place picker (board 05b of the phone Home artboards,
 * approved by the owner on 2026-09-30): the workspace at the top, its folders
 * under it as a tree you open a level at a time, or — once something is typed
 * into "Find a folder" — every folder whose name has those letters, flat, each
 * saying where it is.
 *
 * Pure, so what is listed, in what order and at what depth is pinned by a
 * test rather than by clicking around (`__tests__/newFolderPlace.test.ts`).
 */

import { baseName, folderLabel, parentPath } from "./paths";

/** Each folder on the way down, by its label. */
const steps = (folder: string): string[] => folder.split("/").map(folderLabel);

export interface PickerRow {
  /** The folder; `""` is the top of the workspace. */
  path: string;
  label: string;
  /** Steps in from the left: 0 for the workspace, 1 for its folders. */
  depth: number;
  /** A second line: "Top level", or where a found folder lives. */
  sub?: string;
  /** Has folders inside it, so it can be opened. */
  opens: boolean;
  /** Opened, its folders listed under it. */
  open: boolean;
}

/** Folders by the folder they are in, each list in the order a person reads them. */
function childrenOf(folders: readonly string[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const folder of new Set(folders)) {
    if (folder === "" || folder.startsWith(".")) continue;
    const parent = parentPath(folder);
    children.set(parent, [...(children.get(parent) ?? []), folder]);
  }
  for (const list of children.values()) {
    list.sort((a, b) => folderLabel(baseName(a)).localeCompare(folderLabel(baseName(b)), undefined, { sensitivity: "base" }));
  }
  return children;
}

/** `folder` and every folder above it, so a picker can open onto it. */
export function openTo(folder: string): Set<string> {
  const open = new Set<string>([""]);
  for (let at = folder; at !== ""; at = parentPath(at)) open.add(parentPath(at));
  return open;
}

export function pickerRows({
  folders,
  open,
  query,
  rootLabel,
}: {
  folders: readonly string[];
  open: ReadonlySet<string>;
  query: string;
  rootLabel: string;
}): PickerRow[] {
  const children = childrenOf(folders);
  const typed = query.trim().toLocaleLowerCase();
  if (typed !== "") {
    return [...children.values()]
      .flat()
      .filter((folder) => folderLabel(baseName(folder)).toLocaleLowerCase().includes(typed))
      .sort((a, b) => a.localeCompare(b))
      .map((folder) => {
        const parent = parentPath(folder);
        return {
          path: folder,
          label: folderLabel(baseName(folder)),
          depth: 0,
          sub: placeTrail(parent, rootLabel),
          opens: false,
          open: false,
        };
      });
  }
  const rows: PickerRow[] = [
    { path: "", label: rootLabel, depth: 0, sub: "Top level", opens: false, open: true },
  ];
  const walk = (folder: string, depth: number) => {
    for (const child of children.get(folder) ?? []) {
      const opens = (children.get(child)?.length ?? 0) > 0;
      const isOpen = opens && open.has(child);
      rows.push({ path: child, label: folderLabel(baseName(child)), depth, opens, open: isOpen });
      if (isOpen) walk(child, depth + 1);
    }
  };
  walk("", 1);
  return rows;
}

/** "Northwind › Team": where a place is, for the row that names it. */
export function placeTrail(folder: string, rootLabel: string): string {
  return folder === "" ? rootLabel : [rootLabel, ...steps(folder)].join(" › ");
}

/** A place's own name: the folder's, or the workspace's for the top. */
export function placeName(folder: string, rootLabel: string): string {
  return folder === "" ? rootLabel : folderLabel(baseName(folder));
}
