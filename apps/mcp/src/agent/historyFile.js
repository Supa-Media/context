/**
 * A chat's history file in its Tex folder: `tex/history.ledger.json` for a person, `<home>/history.ledger.json` for a
 * group chat (the owner, 2026-11-02: "that ledger ... be like a history file. Instead of a folder"). The row is made
 * here, once, behind a kept exchange; what a read of it answers is the chat's ledger as it is then, from the chat's
 * Tex object (`texStore/historyView.js`), which keeps only a marker under its key.
 *
 * Read only: `write_note` and its neighbours refuse the path (`historyWriteRefusal`), and the object refuses a write
 * over the marker whatever sends it.
 */

import { CONVERSATIONS_FILE, CONVERSATIONS_VIEW_MARKER, HISTORY_FILE, HISTORY_VIEW_MARKER } from "../texStore/historyView.js";
import { isChatHistoryPath } from "../notes/paths.js";

export { CONVERSATIONS_FILE, HISTORY_FILE };

/** A person's history file. */
export const HISTORY_PATH = `tex/${HISTORY_FILE}`;

/** A home's history file. */
export function homeHistoryPath(home) {
  return `${home.folder}/${HISTORY_FILE}`;
}

/** A person's conversations file, beside their history file: a second view of the same chat (`texStore/historyView.js`). */
export const CONVERSATIONS_PATH = `tex/${CONVERSATIONS_FILE}`;

/** A home's conversations file. */
export function homeConversationsPath(home) {
  return `${home.folder}/${CONVERSATIONS_FILE}`;
}

/**
 * The words a tool call naming the history file is refused with, or null for any other path.
 *
 * The predicate is shared with the egress ledger, which marks a read of this same file untrusted
 * (`notes/paths.js` `isChatHistoryPath`): one path judged for opposite reasons, so it is judged once.
 */
export function historyWriteRefusal(path) {
  if (!isChatHistoryPath(path)) return null;
  return "That file is this chat's history, kept by Tex as it happens; it can be read but not written, moved or removed. Nothing was changed.";
}

/**
 * Make the history (or conversations) file's row at `path` when the lookup that just ran (`keys`, `store.keysAt`'s answer) found none
 * there. Never throws: a miss is made on a later exchange.
 */
export async function ensureHistoryFile(store, path, keys) {
  if (keys?.[path] !== false || typeof store?.put !== "function") return;
  const marker = path.endsWith(`/${CONVERSATIONS_FILE}`) ? CONVERSATIONS_VIEW_MARKER : HISTORY_VIEW_MARKER;
  try {
    await store.put(path, marker, { onlyIf: { absent: true }, httpMetadata: { contentType: "application/json" } });
  } catch {
    // Made on the next kept exchange.
  }
}
