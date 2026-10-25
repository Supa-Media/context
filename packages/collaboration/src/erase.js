/**
 * Erasing a trashed note's collaboration history for good, when a keyed
 * workspace's trash is emptied (`docs/decisions/storage-and-credentials/
 * notes-by-id.md`, "Emptying the trash"). The control plane removes the note's
 * row and its bytes; this removes what the engine kept for it: the document
 * state, its revisions and structural journals, and the head at the note's
 * trash name. Any other head that still names the document (the old name's
 * `moved` fence) keeps identity and routing only, as a permanent delete
 * leaves it (`purgeDocumentState`).
 *
 * Reads and writes no Markdown. Safe to run again: a name with no head left is
 * `{ erased: false }`.
 *
 * The note's row is gone before this runs, so the store cannot say which id
 * the trash name held: the caller names it (`noteId`), and the head filed
 * under that id (`address.js`) is erased too.
 */

import { fail, headKey, readObject, requireSupported } from "./storage.js";
import { purgeDocumentState } from "./purge.js";
import { noteHeadKey } from "./address.js";

export async function eraseDocument(store, path, options = {}) {
  requireSupported(store);
  const atName = typeof path === "string" && path !== "" ? await erasePathHead(store, path) : { erased: false };
  if (typeof options?.noteId !== "string") return atName;
  const byNote = await eraseHeadAt(store, noteHeadKey(options.noteId));
  return byNote.erased ? byNote : atName;
}

/** Erase the history of the head at `key`, then the head. */
async function eraseHeadAt(store, key) {
  const object = await readObject(store, key);
  if (!object) return { erased: false };
  let head;
  try {
    head = JSON.parse(object.text);
  } catch {
    head = null;
  }
  if (head && typeof head.documentId === "string" && typeof head.generation === "string") {
    await purgeDocumentState(store, { documentId: head.documentId, generation: head.generation, permanent: true });
  }
  const current = await readObject(store, key);
  if (current) {
    const removed = await store.delete(key, { onlyIf: { etagMatches: current.etag } });
    if (removed === null && (await readObject(store, key))) throw fail("PURGE_CONFLICT", "collaboration head changed while it was erased");
  }
  return head && typeof head.documentId === "string" ? { erased: true, documentId: head.documentId } : { erased: true };
}

async function erasePathHead(store, path) {
  requireSupported(store);
  // Not `requireConditionalDelete`: R2 ignores If-Match on DELETE, and nothing races an erase. The note's row
  // is gone before this runs, so no editor can open the name, and its deletes are conditional where honoured.
  if (typeof store.delete !== "function") throw fail("UNSUPPORTED_STORAGE", "erasing collaboration history requires delete");
  // The head filed at the name itself, read directly: the row is gone, so no id names it.
  return await eraseHeadAt(store, await headKey(path));
}
