/**
 * The Messages backup's log, read back for its owner's Download as folders
 * (`functions/messagesExport.ts`; `docs/decisions/communications/messages-backup.md`).
 *
 * The log is plumbing under `.context/messages/imessage/log/`: no tree row
 * names it, so it is read by key, through the store the barrier opened without
 * the id layout (as old copies are), one page at a time by the pager the
 * gateway's own download route uses (`packages/communications/src/backupLog.js`).
 */

import { BACKUP_LOG_PREFIX, LOG_PAGE_OBJECTS, readLogPage } from "../../../../../packages/communications/src/backupLog.js";
import type { FileStore } from "../fileOps/store";

export { LOG_PAGE_OBJECTS };
export const MESSAGES_LOG_PREFIX: string = BACKUP_LOG_PREFIX;

export interface MessagesLogPage {
  kind: "messagesLog";
  objects: { key: string; text: string }[];
  /** The key to read after, or null when the log is finished. */
  next: string | null;
}

/** One page of the log, after `after` (a key an earlier page answered). */
export async function readMessagesLogPage(store: FileStore, after: string | undefined): Promise<MessagesLogPage> {
  const page = (await readLogPage(store, after)) as { objects: { key: string; text: string }[]; next: string | null };
  return { kind: "messagesLog", ...page };
}
