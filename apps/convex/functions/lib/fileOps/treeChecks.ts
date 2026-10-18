/**
 * Whether a name is free, asked of the Convex tree, and the write that makes
 * the answer true where storage can.
 *
 * Step 3 of the convex-only plan (owner, 2026-10-13: "the only thing that
 * should be reading from storage directly should be actually opening and
 * editing a note"). A move's or a copy's destination, an archive's free name,
 * a duplicate's, a new folder, a restored note and a routine's run log used to
 * learn whether a name was taken by GETting it or listing its folder. They ask
 * the tree now (`lib/nodes/treeNames.ts`, `lib/nodes/treeTaken.ts`), through
 * pending moves, and the bucket is opened only for the notes being written.
 *
 * **The tree can be a few seconds behind** (a gateway write re-checks it a
 * second or so later; a file written past us waits for the next sweep). So
 * the answer is an early refusal, and the truth is the write:
 *
 * - on storage that enforces a create (`conditionalCreate`: R2, S3), every
 *   destination is written `onlyIf: { absent: true }` (`createAbsent`), and a
 *   name the tree missed is refused there, never overwritten;
 * - on storage that cannot (B2, Wasabi, and anything the connect probe found
 *   without it), the tree's answer is the only one. A file written past the
 *   app in the seconds before it hears of it can be overwritten by a move or
 *   copy onto that exact name. That is the honest degradation; the connect
 *   screen already names such storage as without safe writes.
 *
 * A store the barrier did not attach a tree to (the unit tests' in-memory
 * store) answers from its own listing: there it is the only tree there is.
 * Every store the console and the move worker hand an operation has one
 * (`fileOperationBarrier.ts`, `moveBarrier.ts`).
 */

import { FileOpError } from "./errors";
import type { FileStore } from "./store";

/** The tree's names, as the barrier attaches them (`attachTreeListing`). */
export interface TreeNames extends Pick<FileStore, "list"> {
  /** Which of `paths` a live file is drawn at, and which have something drawn under them. Unfiltered. */
  taken(paths: readonly string[]): Promise<{ files: string[]; folders: string[] }>;
  /** Which folder does each built-in job, and the rows whose job is written on them (`folderJobs.ts`). Unfiltered. */
  jobs?(): Promise<TreeJobs>;
}

/** `nodesGateway.folderJobs`'s answer. */
export interface TreeJobs {
  jobs: Record<string, string | null>;
  roots: string[];
  claimed: { path: string; role: string }[];
}

/** The tree's folder jobs, or null for a store with no tree attached (the unit tests' own store). */
export async function treeJobs(store: FileStore): Promise<TreeJobs | null> {
  const tree = (store as { treeListing?: TreeNames }).treeListing;
  return tree !== undefined && typeof tree.jobs === "function" ? await tree.jobs() : null;
}

function attached(store: FileStore): TreeNames | null {
  const tree = (store as { treeListing?: TreeNames }).treeListing;
  return tree !== undefined && typeof tree.taken === "function" ? tree : null;
}

/** Which of `paths` the tree draws a note or file at. Unfiltered: the caller decides what to say. */
export async function filesInTree(store: FileStore, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const tree = attached(store);
  if (tree === null) {
    // No tree attached: the store is its own (see the header).
    const found = new Set<string>();
    for (const path of paths) if ((await store.get(path)) !== null) found.add(path);
    return found;
  }
  const found = new Set<string>();
  for (let at = 0; at < paths.length; at += TAKEN_BATCH) {
    for (const path of (await tree.taken(paths.slice(at, at + TAKEN_BATCH))).files) found.add(path);
  }
  return found;
}

/** Whether the tree draws a note or file at `path`. */
export async function fileInTree(store: FileStore, path: string): Promise<boolean> {
  return (await filesInTree(store, [path])).has(path);
}

/** Names one `taken` ask carries (`TAKEN_PATHS` in `lib/nodes/treeTaken.ts`). */
const TAKEN_BATCH = 100;

/**
 * Write `key` only if nothing is there, where the store can hold a write to
 * that (`conditionalCreate`); `DESTINATION_EXISTS` when something is. On a
 * store that cannot, the write is plain: the tree's answer, asked before, was
 * the check (see the header).
 */
export async function createAbsent(
  store: FileStore,
  key: string,
  body: Parameters<FileStore["put"]>[1],
  options: { contentType?: string } = {},
): Promise<Awaited<ReturnType<FileStore["put"]>>> {
  const guarded = store.capabilities?.conditionalCreate === true;
  const put = await store.put(key, body, {
    ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    ...(guarded ? { onlyIf: { absent: true } } : {}),
  } as Parameters<FileStore["put"]>[2]);
  if (put === null) throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${key}.`);
  return put;
}
