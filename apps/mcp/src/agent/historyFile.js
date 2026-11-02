/**
 * A chat's history file in its Tex folder: `tex/history.ledger.json` for a person, `<home>/history.ledger.json` for a
 * group chat (the owner, 2026-11-02: "that ledger ... be like a history file. Instead of a folder"). The row is made
 * here, once, behind a kept exchange; what a read of it answers is the chat's ledger as it is then, from the chat's
 * Tex object (`texStore/historyView.js`), which keeps only a marker under its key.
 *
 * Read only: `write_note` and its neighbours refuse the path (`historyWriteRefusal`), and the object refuses a write
 * over the marker whatever sends it.
 */

import { HISTORY_FILE, HISTORY_VIEW_MARKER } from "../texStore/historyView.js";

export { HISTORY_FILE };

/** A person's history file. */
export const HISTORY_PATH = `tex/${HISTORY_FILE}`;

/** A home's history file. */
export function homeHistoryPath(home) {
  return `${home.folder}/${HISTORY_FILE}`;
}

const HISTORY_NAME = new RegExp(`(?:^|/)tex/(?:groups/[^/]+/)?${HISTORY_FILE.replace(/\./g, "\\.")}$`, "i");

/** The words a tool call naming the history file is refused with, or null for any other path. */
export function historyWriteRefusal(path) {
  if (typeof path !== "string") return null;
  const bare = path.trim().replace(/^(?:\.\/|\/)+/, "").replace(/^@[^/]*\/+/, "").replace(/\/{2,}/g, "/");
  if (!HISTORY_NAME.test(bare)) return null;
  return "That file is this chat's history, kept by Tex as it happens; it can be read but not written, moved or removed. Nothing was changed.";
}

/**
 * Make the history file's row at `path` when the lookup that just ran (`keys`, `store.keysAt`'s answer) found none
 * there. Never throws: a miss is made on a later exchange.
 */
export async function ensureHistoryFile(store, path, keys) {
  if (keys?.[path] !== false || typeof store?.put !== "function") return;
  try {
    await store.put(path, HISTORY_VIEW_MARKER, { onlyIf: { absent: true }, httpMetadata: { contentType: "application/json" } });
  } catch {
    // Made on the next kept exchange.
  }
}
