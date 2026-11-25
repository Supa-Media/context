/**
 * The areas a project can serve, for its page's "area" value: every area in
 * the Areas folder, sub-areas included, each read by its name
 * ("Engineering / CI CD"), from the Areas page's own read through the same
 * page cache. Read only on a project's page (`enabled`), so no other folder
 * page pays for it. See `areaProjects.ts`.
 */

import { useMemo } from "react";
import { useFolderNotes, type FolderPageHost } from "../useFolderPage";
import { areaKey } from "./areaProjects";
import { areaTitle, areaTree, type AreaNode } from "./seat";

export interface AreaChoices {
  readonly choices: readonly string[];
  readonly named: (folder: string) => string;
}

function flatten(node: AreaNode, trail: string, into: Map<string, string>): void {
  for (const sub of node.areas) {
    const name = trail === "" ? areaTitle(sub.seat.name) : `${trail} / ${areaTitle(sub.seat.name)}`;
    into.set(sub.seat.folder, name);
    flatten(sub, name, into);
  }
}

/** An area line's name: the area's, or, for a line naming no area here, its last folder's. */
export function areaName(folder: string, names: ReadonlyMap<string, string>): string {
  const key = areaKey(folder);
  for (const [path, name] of names) if (areaKey(path) === key) return name;
  const said = folder.replace(/\/+$/, "");
  return areaTitle(said.slice(said.lastIndexOf("/") + 1));
}

export function useAreaChoices(host: FolderPageHost | undefined, root: string, enabled: boolean): AreaChoices | undefined {
  const read = useFolderNotes(enabled && root !== "" ? host : undefined, root);
  return useMemo(() => {
    if (!enabled || read.notes === null) return undefined;
    const names = new Map<string, string>();
    flatten(areaTree(root, root, read.notes), "", names);
    return { choices: [...names.keys()], named: (folder: string) => areaName(folder, names) };
  }, [enabled, read.notes, root]);
}
