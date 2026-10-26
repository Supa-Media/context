// Reading the Messages backup's log back, a page at a time, for whoever
// downloads it: the console's Download as folders (through Convex) and the
// Mac app's Download messages (through the gateway). One pager, so both read
// the same objects in the same order.
//
// Keys under the log sort in arrival order within each group (`yyyy/mm`,
// `chats`, `people`), and a record always lands in the same group, so reading
// in key order is reading in the order the fold needs. A page ends at a key
// and the next starts after it.

import { BACKUP_PREFIX } from "./backup.js";

export const BACKUP_LOG_PREFIX = `${BACKUP_PREFIX}log/`;
/** The gateway route that answers a page to the owner (`apps/mcp/src/communications/messagesBackupRead.js`). */
export const MESSAGES_BACKUP_LOG_ROUTE = "/messages/imessage/log";
/** Objects one page reads at most. */
export const LOG_PAGE_OBJECTS = 50;
/** Characters of text one page carries at most. One batch object is at most `LIMITS.bodyBytes`, so one always fits. */
export const LOG_PAGE_CHARS = 4 * 1024 * 1024;

/**
 * One page of the log after `after` (a key an earlier page answered):
 * `{ objects: [{ key, text }], next }`, `next` null when the log is finished.
 * An `after` outside the log answers an empty, finished page.
 *
 * @param {{ list(options: object): Promise<any>, get(key: string): Promise<any> }} store
 * @param {string | undefined} after
 */
export async function readLogPage(store, after) {
  if (after !== undefined && !String(after).startsWith(BACKUP_LOG_PREFIX)) return { objects: [], next: null };
  const listed = await store.list({ prefix: BACKUP_LOG_PREFIX, limit: LOG_PAGE_OBJECTS, ...(after ? { startAfter: after } : {}) });
  // A store that ignores `startAfter` would hand the first page back for ever: checked, not trusted.
  const keys = (listed?.objects ?? [])
    .map((object) => object.key)
    .filter((key) => typeof key === "string" && key.startsWith(BACKUP_LOG_PREFIX) && (after === undefined || key > after))
    .sort();
  const objects = [];
  let chars = 0;
  for (const key of keys) {
    const object = await store.get(key);
    // A deleted object is answered as absent: it holds nothing to copy.
    const text = object === null || object === undefined ? "" : await object.text();
    if (objects.length > 0 && chars + text.length > LOG_PAGE_CHARS) break;
    objects.push({ key, text });
    chars += text.length;
  }
  // Nothing past `after` on a listing that says there is more: the store did not move, and the
  // page says so by answering `after` again, which a reader takes as a log it could not finish.
  if (objects.length === 0) return { objects, next: listed?.truncated ? (after ?? null) : null };
  const finished = objects.length === keys.length && !listed?.truncated;
  return { objects, next: finished ? null : objects.at(-1).key };
}
