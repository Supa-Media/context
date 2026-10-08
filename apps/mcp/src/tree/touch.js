/**
 * The write path's half of keeping the tree table true: after a change, look
 * at what it touched in the bucket and record what is there now.
 *
 * Deliberately a re-check rather than a translation of the change. A move, an
 * archive, a folder delete and a restore each change the bucket in their own
 * way, and teaching this file every one of them is a second implementation of
 * each to drift from the first. Listing what a change named — the key itself,
 * and everything under it as a folder — is correct whatever the change was,
 * and costs two list requests a path.
 *
 * A change that names more paths than it is worth re-checking one by one, or
 * a folder too big to list here, marks the table dirty instead: the next read
 * of it starts a sweep, which lists everything.
 *
 * Never throws: the change has already landed in the bucket, the table is a
 * derivative, and a sweep repairs anything this misses.
 */

import {
  TREE_STATE,
  TREE_STATEMENTS,
  goneStatements,
  observeStatements,
  plumbingRoot,
  rowOf,
  setStateStatements,
  vanishedStatements,
} from "./table.js";

/** Paths one change may re-check individually. */
export const TOUCH_PATHS = 50;

/** List pages one folder's re-check may walk. */
export const TOUCH_FOLDER_PAGES = 10;

/** A path as the bucket spells it, or null for one the table does not keep. */
export function touchablePath(value) {
  if (typeof value !== "string") return null;
  const path = value.replace(/^\/+|\/+$/g, "");
  if (path === "" || plumbingRoot(path) !== null || path.startsWith(".")) return null;
  return path;
}

async function folderRows(store, prefix) {
  const objects = [];
  let request = {};
  for (let page = 0; page < TOUCH_FOLDER_PAGES; page += 1) {
    const listing = await store.list({ prefix, limit: 1000, ...request });
    objects.push(...(listing.objects ?? []));
    if (!listing.truncated) return objects;
    if (!listing.cursor) return null;
    request = { cursor: listing.cursor };
  }
  return null;
}

/**
 * Re-check `paths` (each a note or a folder) and `files` (each known to be a
 * single key, so no folder under it is listed).
 *
 * @param {{ list: Function }} store
 * @param {{ runAll: Function }} client
 * `left` names, for a key this change took away, the tree-hint audiences
 * that could see it before (`table.js`, "What changed since"). A key it does
 * not name that turns out gone is logged with none.
 *
 * @param {{ paths?: string[], files?: string[], left?: { path: string, audiences: string[] }[], now?: () => number }} [options]
 * @returns {Promise<{ checked: number, dirty: boolean }>}
 */
export async function touchTree(store, client, { paths = [], files = [], left = [], now = Date.now } = {}) {
  const audiences = new Map();
  for (const entry of left) {
    const path = touchablePath(entry?.path);
    if (path !== null && Array.isArray(entry.audiences)) audiences.set(path, entry.audiences.filter((value) => typeof value === "string"));
  }
  const asFolder = new Set();
  const asFile = new Set();
  for (const value of paths) {
    const path = touchablePath(value);
    if (path !== null) asFolder.add(path);
  }
  for (const value of files) {
    const path = touchablePath(value);
    if (path !== null && !asFolder.has(path)) asFile.add(path);
  }
  if (asFolder.size + asFile.size === 0) return { checked: 0, dirty: false };

  const markDirty = async () => {
    try {
      await client.runAll(setStateStatements({ [TREE_STATE.dirty]: 1 }));
    } catch {
      // The hourly sweep still comes.
    }
    return { checked: 0, dirty: true };
  };
  if (asFolder.size + asFile.size > TOUCH_PATHS) return await markDirty();

  const statements = [];
  let overflow = false;
  try {
    const check = async (path, folder) => {
      const at = now();
      // The key itself sorts first among everything that starts with it.
      const exact = await store.list({ prefix: path, limit: 1 });
      const first = exact.objects?.[0];
      const row = first?.key === path ? rowOf(first) : null;
      statements.push(...(row !== null ? observeStatements([row], at) : goneStatements([path], at, audiences)));
      if (!folder) return;
      const prefix = `${path}/`;
      const listed = await folderRows(store, prefix);
      if (listed === null) {
        overflow = true;
        return;
      }
      const rows = listed.map(rowOf).filter((value) => value !== null);
      statements.push(...observeStatements(rows, at), ...vanishedStatements(prefix, at));
    };
    await Promise.all([
      ...[...asFolder].map((path) => check(path, true)),
      ...[...asFile].map((path) => check(path, false)),
    ]);
    if (overflow) statements.push(...setStateStatements({ [TREE_STATE.dirty]: 1 }));
    // The tables first, as the projection's batch does: a database made before
    // a table was added has it from the first change after.
    await client.runAll([...TREE_STATEMENTS.map((sql) => ({ sql, params: [] })), ...statements]);
    return { checked: asFolder.size + asFile.size, dirty: overflow };
  } catch {
    return await markDirty();
  }
}

/**
 * Rows a writer already knows the bucket holds — the key it just wrote and
 * the version the store answered with — recorded without listing anything.
 * For the writes that already make a database call (the search projection),
 * so keeping the table current costs them no extra request.
 */
export function writtenStatements(written, at) {
  const rows = [];
  for (const entry of written ?? []) {
    const path = touchablePath(entry?.path);
    if (path === null) continue;
    rows.push([
      path,
      typeof entry.etag === "string" && entry.etag !== "" ? entry.etag : null,
      Number.isFinite(entry.size) ? entry.size : null,
      at,
    ]);
  }
  return observeStatements(rows, at);
}
