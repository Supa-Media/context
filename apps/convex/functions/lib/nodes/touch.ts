/**
 * The write path's half of keeping the tree true: after a change, look at what
 * it touched in the bucket and record what is there now (`apps/mcp/src/tree/
 * touch.js`, ported to the `NodeSink` seam).
 *
 * Deliberately a re-check rather than a translation of the change. A move, an
 * archive, a folder delete and a restore each change the bucket in their own
 * way, and teaching this file every one of them is a second implementation of
 * each to drift from the first. Listing what a change named (the key itself,
 * and everything under it when it is a folder) is right whatever the change
 * was, and costs one or two list requests a path.
 *
 * A change that names more paths than is worth re-checking one by one, or a
 * folder too big to list here, marks the tree dirty instead. The next due
 * sweep lists everything, so nothing is lost, only deferred.
 *
 * Never throws: the change has already landed in the bucket, the tree is a
 * derivative, and a sweep repairs anything this misses.
 */

import {
  NODE_PRIVACY_KEY,
  NODE_TOUCH_FOLDER_PAGES,
  NODE_TOUCH_PATHS,
  nodePath,
  type LeftAudiences,
  type NodeRow,
  type NodeSink,
} from "./table";
import { refreshPrivacyMirror } from "./privacyMirror";
import { observeAll, rowFromObject, type NodeListingStore } from "./sweep";

export interface TouchOptions {
  /** Folders (or notes) the change may have taken away or written under: their whole subtree is listed. */
  paths?: string[];
  /** Single keys known to be one object: only the key itself is checked. */
  files?: string[];
  /** Who could see each key the change took away, before it: the log's gone rows narrow to it. */
  left?: LeftAudiences[];
  now?: () => number;
}

export interface TouchResult {
  checked: number;
  dirty: boolean;
}

/**
 * Re-check what a change touched and record it.
 *
 * A path named both ways is checked as a folder, the wider check. Paths are
 * normalised with `nodePath`, so a leading or trailing slash names the same
 * key the tree stores.
 */
export async function touchNodes(
  store: NodeListingStore,
  sink: NodeSink,
  options: TouchOptions = {},
): Promise<TouchResult> {
  const now = options.now ?? Date.now;
  const folders = new Set<string>();
  const files = new Set<string>();
  for (const value of options.paths ?? []) {
    const path = nodePath(value);
    if (path !== null) folders.add(path);
  }
  for (const value of options.files ?? []) {
    const path = nodePath(value);
    if (path !== null && !folders.has(path)) files.add(path);
  }
  const total = folders.size + files.size;
  if (total === 0) return { checked: 0, dirty: false };
  // Too many to re-check one by one: a sweep is cheaper than this many lists.
  if (total > NODE_TOUCH_PATHS) return await markDirty(sink);

  try {
    let overflow = false;
    const left = options.left ?? [];
    for (const path of folders) {
      if (await checkPath(store, sink, path, true, now, left)) overflow = true;
    }
    for (const path of files) await checkPath(store, sink, path, false, now, left);
    if (folders.has(NODE_PRIVACY_KEY) || files.has(NODE_PRIVACY_KEY)) {
      await refreshPrivacyMirror(store, sink, now);
    }
    if (overflow) await sink.dirty();
    return { checked: total, dirty: overflow };
  } catch {
    return await markDirty(sink);
  }
}

/**
 * Re-check one path: the key itself, and (for a folder) everything under it.
 * Returns true when the folder was too big to list completely.
 *
 * The exact check is a one-key list, because the key sorts first among
 * everything that starts with it: if it is the first key, it exists. A folder
 * whose listing overflows still records the rows it saw, but claims no
 * vanished rows, since it did not see the whole folder.
 */
async function checkPath(
  store: NodeListingStore,
  sink: NodeSink,
  path: string,
  folder: boolean,
  now: () => number,
  left: readonly LeftAudiences[],
): Promise<boolean> {
  const at = now();
  const exact = await store.list({ prefix: path, limit: 1 });
  const first = exact.objects?.[0];
  let exactRow = first !== undefined && (first as { key?: unknown }).key === path ? rowFromObject(first) : null;
  // A store whose prefix listing cannot find a file (Dropbox, whose tree is
  // filled by token since it ignores key order) is asked for the key by name.
  if (exactRow === null && (store as { prefixFindsFiles?: boolean }).prefixFindsFiles === false) {
    const object = await store.get(path);
    if (object !== null) exactRow = rowFromObject({ key: path, etag: object.etag, uploaded: (object as { uploaded?: unknown }).uploaded });
  }
  const rows: NodeRow[] = exactRow === null ? [] : [exactRow];
  const gone = exactRow === null ? [path] : [];
  if (!folder) {
    await observeAll(sink, at, rows, gone, [], left);
    return false;
  }

  const prefix = `${path}/`;
  const listed = await folderObjects(store, prefix);
  if (listed === null) {
    await observeAll(sink, at, rows, gone, [], left);
    return true;
  }
  for (const object of listed) {
    const row = rowFromObject(object);
    if (row !== null) rows.push(row);
  }
  await observeAll(sink, at, rows, gone, [prefix], left);
  return false;
}

/**
 * Every object under `prefix`, following the cursor. `null` when the folder
 * takes more pages than one re-check may walk: the caller marks the tree dirty.
 */
async function folderObjects(store: NodeListingStore, prefix: string): Promise<unknown[] | null> {
  const objects: unknown[] = [];
  let request: { cursor?: string } = {};
  for (let page = 0; page < NODE_TOUCH_FOLDER_PAGES; page += 1) {
    const listing = await store.list({ prefix, limit: 1000, ...request });
    objects.push(...(listing.objects ?? []));
    if (listing.truncated !== true) return objects;
    if (!listing.cursor) return null;
    request = { cursor: listing.cursor };
  }
  return null;
}

async function markDirty(sink: NodeSink): Promise<TouchResult> {
  await sink.dirty().catch(() => undefined);
  return { checked: 0, dirty: true };
}
