// Reading the Messages backup's log back, a page at a time, for whoever
// downloads it: the console's Download as folders (through Convex) and the
// Mac app's Download messages (through the gateway). One pager, so both read
// the same objects in the same order.
//
// Keys under the log sort in arrival order within each group (`yyyy/mm`,
// `chats`, `people`), and a record always lands in the same group, so reading
// in key order is reading in the order the fold needs. A page ends at a key
// and the next starts after it.

import { BACKUP_PREFIX, recordKey } from "./backup.js";

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

// A copy of the backup is the backup as it is kept (owner, 2026-10-27): the
// log's JSON-lines objects and the files, at the paths they have under
// `BACKUP_PREFIX`, so what the person takes home reads the same as what the
// bucket holds and any tool that reads one reads the other.

/** One path segment of a key a copy writes: letters, digits, `.`, `_`, `-`, never a dot first. */
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Where a log object sits in a copy, `log/<group>/<name>.jsonl`, or null for a
 * key that is not one: outside the log, or with a segment no file system
 * should be handed.
 */
export function copyPathOf(key) {
  if (typeof key !== "string" || !key.startsWith(BACKUP_LOG_PREFIX)) return null;
  const relative = key.slice(BACKUP_PREFIX.length);
  return relative.split("/").every((segment) => SEGMENT.test(segment)) ? relative : null;
}

/**
 * Fold records, given in the order they arrived: the later one with the same
 * key wins, as everywhere the backup is read. What a copy needs of it is
 * which conversations there are and which files the live messages hold.
 *
 * @param {Iterable<any>} records
 */
export function foldRecords(records) {
  const latest = new Map();
  for (const record of records) {
    if (record && typeof record === "object" && typeof record.kind === "string") latest.set(recordKey(record), record);
  }
  /** @type {{ messages: any[], chats: Set<string> }} */
  const fold = { messages: [], chats: new Set() };
  for (const record of latest.values()) {
    if (record.kind === "message") {
      fold.messages.push(record);
      fold.chats.add(record.chat);
    }
  }
  return fold;
}
