/**
 * The rules for changing a workspace's tree rows, written once against the
 * `NodeTable` seam (`table.ts`) so the same code runs inside a Convex
 * mutation and over a Map in tests. Nothing here imports Convex.
 *
 * Rows change only through the product's own seam: a write, move, trash or
 * keyed copy reports what it did (`Observation`), and these rules lay it down.
 * Nothing lists the bucket to decide which names exist.
 */

import { folderChain, isKeyed, nodeKey, type NodeTable, type Observation, type StoredNode } from "./table";
import { applyRow } from "./observeRows";

/** Answer of one observation: the paths the tree could not hold, because it holds something else there. */
export interface ObserveResult {
  /** Paths a seam write could not land (`applySeamRow`). Always present, `[]` when none. */
  taken: string[];
}

/**
 * Stores one seam observation. Each keyed row lands under `applySeamRow`; each
 * `gone` key tombstones the keyed row it names, and a folder a tombstone leaves
 * empty is retired with it.
 */
export async function applyObservation(table: NodeTable, obs: Observation): Promise<ObserveResult> {
  // Folders looked up or created in this call, so a batch of files in one
  // folder reads that folder once. Keyed by path: a path names one node.
  const cache = new Map<string, StoredNode | null>();
  const lookup = async (path: string): Promise<StoredNode | null> => {
    if (cache.has(path)) return cache.get(path) ?? null;
    const found = await table.byPath(path);
    cache.set(path, found);
    return found;
  };

  const observed = new Set<string>();
  const taken: string[] = [];
  // Folders a tombstone in this call may have left empty (`retireEmptyFolders`).
  const emptied = new Set<string>();
  const tombstone = (path: string) => {
    const chain = folderChain(path);
    if (chain.length > 0) emptied.add(chain[chain.length - 1]);
  };
  for (const row of obs.rows) {
    const path = nodeKey(row.path);
    if (path === null) continue;
    observed.add(path);
    if ((await applyRow(table, lookup, cache, obs, path, row)) === "taken") taken.push(path);
  }

  for (const key of obs.gone) {
    const path = nodeKey(key);
    // A key written and gone in one observation is contradictory; the write is
    // the fresher evidence, so the row stays.
    if (path === null || observed.has(path)) continue;
    const node = await lookup(path);
    if (node === null || node.kind !== "file" || node.goneAt !== undefined) continue;
    // A seam gone speaks for keyed rows only.
    if (!isKeyed(node)) continue;
    if (node.observedAt > obs.at) continue;
    await table.patch(node.id, { goneAt: obs.at });
    await table.logChange?.(path, true);
    cache.set(path, { ...node, goneAt: obs.at });
    tombstone(path);
  }

  await retireEmptyFolders(table, lookup, cache, obs.at, emptied);
  return { taken };
}

/** Folder re-checks one observation may make while retiring emptied folders: a bound on work. */
const RETIRE_CHECKS = 200;

/**
 * Marks gone every folder a tombstone left with nothing live in it, and then
 * its parent if that is now empty too, up the chain.
 *
 * Why the tree needs this: a listing draws a folder from its row, so a folder
 * emptied by a change would stay in the sidebar without it. A folder marked
 * gone comes back the moment a child is written in it again (`ensureFolder`).
 *
 * A folder observed after this observation is left alone: something newer
 * saw it here.
 */
async function retireEmptyFolders(
  table: NodeTable,
  lookup: (path: string) => Promise<StoredNode | null>,
  cache: Map<string, StoredNode | null>,
  at: number,
  emptied: Set<string>,
): Promise<void> {
  // Deepest first, so a parent is judged after the children this call retires.
  const queue = [...emptied].sort((a, b) => b.split("/").length - a.split("/").length);
  emptied.clear();
  for (let checks = 0; checks < RETIRE_CHECKS && queue.length > 0; checks += 1) {
    const path = queue.shift() as string;
    const node = await lookup(path);
    if (node === null || node.kind !== "folder" || node.goneAt !== undefined) continue;
    if (node.observedAt > at) continue;
    if (await table.hasLiveChild(node.id)) continue;
    await table.patch(node.id, { goneAt: at });
    cache.set(path, { ...node, goneAt: at });
    const chain = folderChain(path);
    if (chain.length > 0) queue.push(chain[chain.length - 1]);
  }
}
