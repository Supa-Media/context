/**
 * The Messages backup's log, read back for its owner's Download as folders
 * (`functions/messagesExport.ts`; `docs/decisions/communications/messages-backup.md`).
 *
 * The log is plumbing under `.context/messages/imessage/log/`: no tree row
 * names it, so it is read by key, through the store the barrier opened without
 * the id layout (as old copies are), one page at a time. Keys sort in arrival
 * order within each month, which is the order the fold needs, so a page ends
 * at a key and the next starts after it.
 */

import type { FileStore } from "../fileOps/store";

export const MESSAGES_LOG_PREFIX = ".context/messages/imessage/log/";
/** Objects one page reads at most. */
export const LOG_PAGE_OBJECTS = 50;
/** Characters of text one page carries at most, well under what an action may return. */
export const LOG_PAGE_CHARS = 4 * 1024 * 1024;

export interface MessagesLogPage {
  kind: "messagesLog";
  objects: { key: string; text: string }[];
  /** The key to read after, or null when the log is finished. */
  next: string | null;
}

/** One page of the log, after `after` (a key an earlier page answered). */
export async function readMessagesLogPage(store: FileStore, after: string | undefined): Promise<MessagesLogPage> {
  if (after !== undefined && !after.startsWith(MESSAGES_LOG_PREFIX)) return { kind: "messagesLog", objects: [], next: null };
  const listed = await store.list({ prefix: MESSAGES_LOG_PREFIX, limit: LOG_PAGE_OBJECTS, ...(after ? { startAfter: after } : {}) });
  // A store that ignores `startAfter` would hand the first page back for ever: checked, not trusted.
  const keys = (listed.objects ?? [])
    .map((object) => object.key)
    .filter((key) => key.startsWith(MESSAGES_LOG_PREFIX) && (after === undefined || key > after))
    .sort();
  const objects: { key: string; text: string }[] = [];
  let chars = 0;
  for (const key of keys) {
    const object = await store.get(key);
    // A deleted object leaves a marker the store answers as absent: it holds nothing to copy.
    const text = object === null ? "" : await object.text();
    if (objects.length > 0 && chars + text.length > LOG_PAGE_CHARS) break;
    objects.push({ key, text });
    chars += text.length;
  }
  const last = objects.at(-1)?.key;
  const finished = last === undefined || (objects.length === keys.length && !listed.truncated);
  return { kind: "messagesLog", objects, next: finished ? null : last };
}
