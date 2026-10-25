/**
 * The backfill that files every existing head by its note id (`address.js`),
 * a page of the bucket's path-filed heads at a time. A note opened since the
 * change is filed by its first read; this reaches the rest, so a move never
 * has to carry a head again.
 *
 * Each head is filed under the id it records. A head made before heads
 * recorded ids is filed under the id of the row at its name now, if there is
 * one; `load.js` proves it is that note's before using it, as it did at the
 * path. A head that moved away, was deleted, or was already filed stays as it
 * is. Safe to run again: a filed head is a `migrated` fence, and the copy is
 * create-only.
 */

import { HEAD_PREFIX, SCHEMA_VERSION } from "./storage.js";
import { NOTE_HEAD_PREFIX, adoptPathHead, noteIdOf } from "./address.js";

const PAGE = 100;

/**
 * File one page of path heads by note id.
 *
 * @param {object} store
 * @param {{cursor?: string, limit?: number}} [options]
 * @returns {Promise<{cursor: string|null, done: boolean, filed: number, left: number}>}
 *   `cursor` continues the listing; `left` counts heads with no note to file under.
 */
export async function fileHeadsByNote(store, options = {}) {
  if (typeof store?.list !== "function") throw new TypeError("the backfill lists the bucket");
  const limit = Math.min(Math.max(Number(options.limit) || PAGE, 1), 1000);
  const page = await store.list({ prefix: HEAD_PREFIX, cursor: options.cursor || undefined, limit });
  let filed = 0;
  let left = 0;
  for (const object of page.objects ?? []) {
    if (typeof object?.key !== "string" || object.key.startsWith(NOTE_HEAD_PREFIX)) continue;
    const found = await store.get(object.key);
    if (!found) continue;
    let head;
    try {
      head = JSON.parse(await found.text());
    } catch {
      continue;
    }
    if (head?.schemaVersion !== SCHEMA_VERSION || typeof head.path !== "string") continue;
    const status = head.status || "active";
    if (status === "moved" || status === "deleted") continue;
    const noteId = typeof head.noteId === "string" && head.noteId !== "" ? head.noteId : await noteIdOf(store, head.path);
    if (noteId === null) {
      left += 1;
      continue;
    }
    if ((await adoptPathHead(store, head.path, noteId)) !== null) filed += 1;
  }
  const more = page.truncated === true && typeof page.cursor === "string" && page.cursor !== "" && page.cursor !== options.cursor;
  return { cursor: more ? page.cursor : null, done: !more, filed, left };
}
