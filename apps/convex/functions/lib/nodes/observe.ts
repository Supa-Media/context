/**
 * The rules for changing a workspace's tree rows, written once against the
 * `NodeTable` seam (`table.ts`) so the same code runs inside a Convex
 * mutation and over a Map in tests. Nothing here imports Convex.
 *
 * Every rule is "last observation wins": a row carries the time the bucket
 * was seen to hold it (`observedAt`), and an observation older than what is
 * stored never overwrites it. That is what lets a sweep and a write-path
 * re-check race each other without either one undoing the other.
 */

import {
  PRUNE_BATCH,
  VANISH_SCAN,
  folderChain,
  isKeyed,
  nodeKey,
  type NodeTable,
  type NodeTreeState,
  type Observation,
  type StoredNode,
} from "./table";
import { applyRow } from "./observeRows";

/** Rows one `underPrefix` page reads while a vanish scan walks a prefix. */
const VANISH_PAGE = 500;

/**
 * Where a vanish scan stopped: the index of the `vanishedUnder` prefix it was
 * in, and the last path it read in that prefix. Absent means the start.
 *
 * A cursor, not a re-send from the top, because the scan's own writes make the
 * top of a large prefix look already done: re-reading from the start would
 * spend the whole budget on tombstones and never reach the rest.
 */
export interface VanishCursor {
  index: number;
  after?: string;
}

/** Thrown where a sweep is asked to run over a store that cannot be resumed in key order. */
export class NodeTreeUnsupportedError extends Error {
  constructor() {
    super("the tree of this store cannot be swept");
    this.name = "NodeTreeUnsupportedError";
  }
}

/**
 * What `applyObservation` answers: `more` means the vanish scan ran out of
 * budget (call again with `next`, every write is idempotent); `taken` lists the
 * paths a seam observation could not write because the tree holds something
 * else at them (`applySeamRow`). Always present, `[]` when none.
 */
export interface ObserveResult {
  more: boolean;
  next?: VanishCursor;
  taken: string[];
}

/**
 * Stores one observation. `more` means the vanish scan ran out of budget:
 * call again with `next` (every write is idempotent, so re-applying the rows
 * is harmless).
 *
 * Bucket and seam observations differ (`Observation.source`): a bucket one
 * never changes a keyed row, and in a keyed workspace adopts no path; a seam
 * one writes keyed rows and tombstones only keyed rows, and ignores
 * `vanishedUnder`, which only a listing of path objects can claim.
 */
export async function applyObservation(
  table: NodeTable,
  obs: Observation,
  from: VanishCursor = { index: 0 },
): Promise<ObserveResult> {
  const seam = obs.source === "seam";
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
    // A key listed and gone in one observation is contradictory; the listing
    // is the fresher evidence, so the row stays.
    if (path === null || observed.has(path)) continue;
    const node = await lookup(path);
    if (node === null || node.kind !== "file" || node.goneAt !== undefined) continue;
    // A bucket gone speaks for unkeyed rows only; a seam gone for keyed rows only.
    const eligible = seam ? isKeyed(node) : !isKeyed(node);
    if (!eligible) continue;
    if (node.observedAt > obs.at) continue;
    await table.patch(node.id, { goneAt: obs.at });
    await table.logChange?.(path, true);
    cache.set(path, { ...node, goneAt: obs.at });
    tombstone(path);
  }

  let scanned = 0;
  // Only a listing of path objects can say a prefix is empty now.
  const prefixes = seam ? [] : obs.vanishedUnder;
  for (let index = from.index; index < prefixes.length; index += 1) {
    const prefix = prefixes[index];
    if (!prefix.endsWith("/")) continue;
    let after = index === from.index ? from.after : undefined;
    for (;;) {
      const budget = VANISH_SCAN - scanned;
      if (budget <= 0) {
        await retireEmptyFolders(table, lookup, cache, obs.at, emptied);
        return { more: true, next: { index, after }, taken };
      }
      const limit = Math.min(VANISH_PAGE, budget);
      const page = await table.underPrefix(prefix, { after, limit });
      scanned += page.length;
      for (const node of page) {
        if (node.kind !== "file" || node.goneAt !== undefined || isKeyed(node)) continue;
        if (node.observedAt >= obs.at || observed.has(node.path)) continue;
        await table.patch(node.id, { goneAt: obs.at });
        await table.logChange?.(node.path, true);
        cache.delete(node.path);
        tombstone(node.path);
      }
      if (page.length < limit) break;
      after = page[page.length - 1].path;
    }
  }
  await retireEmptyFolders(table, lookup, cache, obs.at, emptied);
  return { more: false, taken };
}

/** Folder re-checks one observation may make while retiring emptied folders: a bound on work. */
const RETIRE_CHECKS = 200;

/**
 * Marks gone every folder a tombstone left with nothing live in it, and then
 * its parent if that is now empty too, up the chain.
 *
 * Why the tree needs this from phase 2: a listing draws a folder from its
 * row, where the bucket draws one only while some key sits under it. Without
 * this, a folder moved or emptied by a change would stay in the sidebar until
 * the next full sweep pruned it. A folder marked gone comes back the moment a
 * child is observed in it again (`ensureFolder`).
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

/**
 * Removes what nobody observed since `startedAt`: live files, tombstones and
 * folders whose last observation predates the sweep. Bounded by `PRUNE_BATCH`.
 *
 * A folder's `observedAt` is at least its newest child's, so a folder pruned
 * here has no child a later observation kept; children and folders are
 * removed in the same sweep, so a child may briefly name a removed parent
 * (`parentId`), and nothing reads `parentId` to decide what is visible.
 */
export async function pruneUnobserved(
  table: NodeTable,
  startedAt: number,
): Promise<{ more: boolean; removedFiles: number }> {
  // `observedBefore` never returns a keyed row (`convexTable.ts`); a keyed row
  // is the store seam's, so no age makes it stale here.
  const batch = await table.observedBefore(startedAt, PRUNE_BATCH);
  let removedFiles = 0;
  for (const node of batch) {
    if (isKeyed(node)) continue;
    // A live file nobody saw leaves the tree here; a tombstone was logged when it was laid.
    if (node.kind === "file" && node.goneAt === undefined) await table.logChange?.(node.path, true);
    await table.remove(node.id);
    if (node.kind === "file") removedFiles += 1;
  }
  return { more: batch.length >= PRUNE_BATCH, removedFiles };
}

/** Whether a `savePrivacy` observed at `at` replaces what is stored at `storedAt`. */
export function privacyIsNewer(storedAt: number | undefined, at: number): boolean {
  return storedAt === undefined || storedAt <= at;
}

/** A tree with no bookkeeping yet: never swept, nothing listed. */
export function emptyTreeState(): NodeTreeState {
  return { status: "empty", dirty: false, files: 0 };
}

/**
 * Starts (or joins) a sweep at `at`. Takes the lease, clears `dirty`. A fresh
 * start (no cursor, or no start time) lists from the key "" and starts the
 * clock at `at`; joining a running sweep keeps its cursor and the EARLIER of
 * the two starts. A ready tree stays ready: a re-sweep serves the old rows
 * until it finishes.
 */
export function beginState(
  state: NodeTreeState | null,
  at: number,
): { state: NodeTreeState; cursor: string; startedAt: number } {
  const base = state ?? emptyTreeState();
  // A store once found unable to list is tried again (`nodeSweepDue` waits a
  // day): the sweep now pages a store that ignores key order by its own
  // continuation token (`sweep.ts`), so most such trees fill on this try.
  if (base.status === "unsupported") {
    const retry: NodeTreeState = { status: "filling", cursor: "", startedAt: at, leaseAt: at, dirty: false, files: base.files };
    return { state: retry, cursor: "", startedAt: at };
  }
  const fresh = base.cursor === undefined || base.startedAt === undefined;
  const cursor = fresh ? "" : (base.cursor as string);
  const startedAt = fresh ? at : Math.min(base.startedAt as number, at);
  const next: NodeTreeState = {
    ...base,
    status: base.status === "ready" ? "ready" : "filling",
    cursor,
    startedAt,
    leaseAt: at,
    dirty: false,
  };
  return { state: next, cursor, startedAt };
}

/** A sweep listed through `cursor` at `at`: the lease renews and a prior failure clears. */
export function progressState(state: NodeTreeState | null, cursor: string, at: number): NodeTreeState {
  const base = state ?? emptyTreeState();
  if (base.status === "unsupported") throw new NodeTreeUnsupportedError();
  const next: NodeTreeState = { ...base, cursor, leaseAt: at };
  delete next.error;
  return next;
}

/**
 * A finished sweep: ready, with its live-file count. The cursor, the start,
 * the lease and any error are cleared. `dirty` is kept, because a change that
 * asked for a sweep while this one ran still needs the next one.
 */
export function finishState(state: NodeTreeState | null, at: number, files: number): NodeTreeState {
  const base = state ?? emptyTreeState();
  if (base.status === "unsupported") throw new NodeTreeUnsupportedError();
  return { status: "ready", sweptAt: at, dirty: base.dirty, files };
}

/**
 * The store can be listed neither in key order nor by a continuation token
 * (a listing that says there is more and gives no way to ask for it): not
 * served, and tried again a day later (`nodeSweepDue`), from `at`.
 */
export function unsupportedState(state: NodeTreeState | null, at?: number): NodeTreeState {
  const base = state ?? emptyTreeState();
  return {
    status: "unsupported",
    dirty: base.dirty,
    files: base.files,
    sweptAt: base.sweptAt,
    error: base.error,
    ...(at === undefined ? {} : { leaseAt: at }),
  };
}

/** A change too big to re-check key by key: the next due check starts a sweep. */
export function dirtyState(state: NodeTreeState | null): NodeTreeState {
  return { ...(state ?? emptyTreeState()), dirty: true };
}

/** A pass failed with a fixed, path-free label. */
export function failState(state: NodeTreeState | null, label: string): NodeTreeState {
  return { ...(state ?? emptyTreeState()), error: label };
}
