import { useSyncExternalStore } from "react";

/**
 * The sidebar's folder counts while the map is open.
 *
 * The tree draws no counts of its own: a folder row marks only exceptions, and
 * the owner turned a count beside `0-inbox` down for that reason
 * (`docs/decisions/app-and-console/folder-rows-and-settings.md`). The map is
 * different — its proposal draws every top folder's count beside the tree and
 * moves them as notes land, and a replay winds them back to the playhead — so
 * the counts exist only while the map page says so, for every top folder
 * alike, and vanish when it closes.
 *
 * A module store rather than a React context because the writer (the map, in
 * the document slot) and the reader (the tree, in the sidebar) are different
 * branches of the frame, and the tree's rows must not re-render on every frame
 * of a replay — only a row whose number changed does.
 */

type Counts = { workspaceId: string; byRoot: Readonly<Record<string, number>> };

let current: Counts | null = null;
const listeners = new Set<() => void>();

function same(a: Counts | null, b: Counts | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.workspaceId !== b.workspaceId) return false;
  const ka = Object.keys(a.byRoot);
  if (ka.length !== Object.keys(b.byRoot).length) return false;
  return ka.every((k) => a.byRoot[k] === b.byRoot[k]);
}

/** What the map says each top folder of `workspaceId` holds; `null` when the map closes. */
export function setMapFolderCounts(next: Counts | null): void {
  if (same(current, next)) return;
  current = next;
  for (const listener of listeners) listener();
}

export function mapFolderCounts(): Counts | null {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The count for one top folder of `workspaceId`, or `null` when the map is not saying. */
export function mapFolderCount(workspaceId: string | null, rootPath: string | null): number | null {
  if (current === null || rootPath === null || workspaceId === null || current.workspaceId !== workspaceId) return null;
  const root = rootPath.replace(/\/+$/, "");
  if (root === "" || root.includes("/")) return null;
  return current.byRoot[root] ?? 0;
}

/** A tree row's count, re-rendering only when that number changes. */
export function useMapFolderCount(workspaceId: string | null, rootPath: string | null): number | null {
  const read = () => mapFolderCount(workspaceId, rootPath);
  return useSyncExternalStore(subscribe, read, read);
}
