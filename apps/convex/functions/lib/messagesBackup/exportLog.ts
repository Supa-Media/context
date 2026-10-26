/**
 * The Messages backup's own operations in the barrier
 * (`docs/decisions/communications/messages-backup.md`): its log read back for
 * the owner's Download as folders (`functions/messagesExport.ts`), and the
 * backup erased when the owner deletes it.
 *
 * The backup is plumbing under `.context/messages/imessage/`: no tree row
 * names it, so it is read and removed by key, through the store the barrier
 * opened without the id layout (as old copies are), one page at a time. The
 * log is paged by the pager the gateway's own download route uses
 * (`packages/communications/src/backupLog.js`).
 */

import { BACKUP_PREFIX } from "../../../../../packages/communications/src/backup.js";
import { BACKUP_LOG_PREFIX, LOG_PAGE_OBJECTS, readLogPage } from "../../../../../packages/communications/src/backupLog.js";
import type { FileStore } from "../fileOps/store";

export { LOG_PAGE_OBJECTS };
export const MESSAGES_LOG_PREFIX: string = BACKUP_LOG_PREFIX;
export const MESSAGES_BACKUP_PREFIX: string = BACKUP_PREFIX;
/** Keys one erase page deletes at most. */
export const ERASE_PAGE_KEYS = 500;

export type MessagesBackupOperation = { kind: "readMessagesLog"; after?: string } | { kind: "eraseMessagesBackup"; after?: string };

export interface MessagesLogPage {
  kind: "messagesLog";
  objects: { key: string; text: string }[];
  /** The key to read after, or null when the log is finished. */
  next: string | null;
}

export interface MessagesErasedPage {
  kind: "messagesErased";
  deleted: number;
  /** The key to go on after, or null when nothing under the backup is left. */
  next: string | null;
}

export function isMessagesBackupOperation(operation: { kind: string }): operation is MessagesBackupOperation {
  return operation.kind === "readMessagesLog" || operation.kind === "eraseMessagesBackup";
}

export async function runMessagesBackupOperation(store: FileStore, operation: MessagesBackupOperation): Promise<MessagesLogPage | MessagesErasedPage> {
  if (operation.kind === "readMessagesLog") {
    const page = (await readLogPage(store, operation.after)) as { objects: { key: string; text: string }[]; next: string | null };
    return { kind: "messagesLog", ...page };
  }
  return await eraseMessagesBackupPage(store, operation.after);
}

/**
 * One page of the backup deleted: every key under it, the log, the files and
 * the index's markers alike. Paged by key, so a store that keeps a deleted
 * key as a marker is passed over rather than deleted again for ever.
 */
export async function eraseMessagesBackupPage(store: FileStore, after: string | undefined): Promise<MessagesErasedPage> {
  if (after !== undefined && !after.startsWith(BACKUP_PREFIX)) return { kind: "messagesErased", deleted: 0, next: null };
  const listed = await store.list({ prefix: BACKUP_PREFIX, limit: ERASE_PAGE_KEYS, ...(after ? { startAfter: after } : {}) });
  const keys = (listed.objects ?? [])
    .map((object) => object.key)
    .filter((key) => key.startsWith(BACKUP_PREFIX) && (after === undefined || key > after))
    .sort();
  for (const key of keys) await store.delete(key);
  const last = keys.at(-1);
  return { kind: "messagesErased", deleted: keys.length, next: listed.truncated && last !== undefined ? last : null };
}
