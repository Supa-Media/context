/**
 * The tree's side of the old-copy cleanup (`lib/cleanup/`): what a key means
 * to the rows. Three questions, each answered from the rows and never the
 * bucket:
 *
 *  - `readsKey`: does a live row still read this key? A row keyed at it, or a
 *    live unkeyed row whose path it is. The delete never removes such a key.
 *  - `claimedKey`: does any row, live or gone, name this key as its path or its
 *    key? A key nothing names is counted as `unclaimed` for staff to see.
 *  - `readingPathsPage`: how many live notes are keyed at something other than
 *    their id key, a page of the tree at a time.
 *
 * Counts and booleans only; no path leaves this module in a return value that a
 * log or a label could carry.
 */

import type { Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";
import { COPY_SCAN } from "../nodes/noteIds";
import { cleanupKey } from "../../../../mcp/src/moves/cleanupKeys.js";
import { nodeAt } from "../noteIds/state";

/**
 * Whether a storage key is the id key of this note, whatever the extension:
 * `notes/<id>.md`, or `files/<id>.<ext>`. An extension can change on a rename
 * while the key stays, so the note id is what is compared.
 */
export function storageKeyIsIdKey(storageKey: string, noteId: string): boolean {
  const slash = storageKey.indexOf("/");
  if (slash < 0) return false;
  const folder = storageKey.slice(0, slash);
  if (folder !== "notes" && folder !== "files") return false;
  const name = storageKey.slice(slash + 1);
  return name === noteId || name.startsWith(`${noteId}.`);
}

/** A live row keyed at `key`, or a live unkeyed row at `key`'s path: either reads the key. */
export async function readsKey(db: DatabaseReader, workspaceId: Id<"workspaces">, key: string): Promise<boolean> {
  const keyed = await db
    .query("nodes")
    .withIndex("by_workspace_storageKey", (q) => q.eq("workspaceId", workspaceId).eq("storageKey", key))
    .take(20);
  if (keyed.some((row) => row.goneAt === undefined)) return true;
  const atPath = await nodeAt(db, workspaceId, key);
  return atPath !== null && atPath.goneAt === undefined && atPath.storageKey === undefined;
}

/** Whether any row, live or gone, names this key as its path or its storage key. */
export async function claimedKey(db: DatabaseReader, workspaceId: Id<"workspaces">, key: string): Promise<boolean> {
  if ((await nodeAt(db, workspaceId, key)) !== null) return true;
  const keyed = await db
    .query("nodes")
    .withIndex("by_workspace_storageKey", (q) => q.eq("workspaceId", workspaceId).eq("storageKey", key))
    .first();
  return keyed !== null;
}

/**
 * The keys of a bucket page that a Delete would remove: outside `notes/`,
 * `files/` and the three cleanup folders under `.context/` (`cleanupKey`), and
 * not read by any row now. Order kept.
 */
export async function deletableKeys(db: DatabaseReader, workspaceId: Id<"workspaces">, keys: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const key of keys) {
    if (cleanupKey(key) && !(await readsKey(db, workspaceId, key))) out.push(key);
  }
  return out;
}

/** A page's count: how many of its keys a Delete would remove, and how many of those no row names. */
export async function classifyKeys(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  keys: readonly string[],
): Promise<{ toDelete: number; unclaimed: number }> {
  const counts = { toDelete: 0, unclaimed: 0 };
  for (const key of keys) {
    if (!cleanupKey(key)) continue;
    counts.toDelete += 1;
    if (!(await claimedKey(db, workspaceId, key))) counts.unclaimed += 1;
  }
  return counts;
}

export interface ReadingPage {
  readingPaths: number;
  /** The last path read, when the walk stopped before the end. */
  next?: string;
  done: boolean;
}

/**
 * The live file rows keyed at something other than their id key, in the rows
 * after `after`, reading at most `COPY_SCAN` of them. A row with a storage key
 * but no note id counts too: nothing can say it is the id key.
 */
export async function readingPathsPage(db: DatabaseReader, workspaceId: Id<"workspaces">, after: string | undefined): Promise<ReadingPage> {
  const rows = db.query("nodes").withIndex("by_workspace_path", (q) =>
    after === undefined ? q.eq("workspaceId", workspaceId) : q.eq("workspaceId", workspaceId).gt("path", after),
  );
  let readingPaths = 0;
  let read = 0;
  for await (const row of rows) {
    read += 1;
    if (row.kind === "file" && row.goneAt === undefined && row.storageKey !== undefined) {
      if (row.noteId === undefined || !storageKeyIsIdKey(row.storageKey, row.noteId)) readingPaths += 1;
    }
    if (read >= COPY_SCAN) return { readingPaths, next: row.path, done: false };
  }
  return { readingPaths, done: true };
}
