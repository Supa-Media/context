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
 */

import { fail, headKey, readObject, requireSupported } from "./storage.js";
import { readHead } from "./records.js";
import { purgeDocumentState } from "./purge.js";

export async function eraseDocument(store, path) {
  requireSupported(store);
  // Not `requireConditionalDelete`: R2 ignores If-Match on DELETE, and nothing races an erase. The note's row
  // is gone before this runs, so no editor can open the name, and its deletes are conditional where honoured.
  if (typeof store.delete !== "function") throw fail("UNSUPPORTED_STORAGE", "erasing collaboration history requires delete");
  const key = await headKey(path);
  const head = await readHead(store, path).catch((error) => {
    // A head the engine cannot read names no history it could purge; only the head itself is left to remove.
    if (error?.code === "CORRUPT_STATE") return { corrupt: true };
    throw error;
  });
  if (head === null) return { erased: false };
  if (head.corrupt !== true) {
    await purgeDocumentState(store, { documentId: head.documentId, generation: head.generation, permanent: true });
  }
  const current = await readObject(store, key);
  if (current) {
    const removed = await store.delete(key, { onlyIf: { etagMatches: current.etag } });
    if (removed === null && (await readObject(store, key))) throw fail("PURGE_CONFLICT", "collaboration path changed while it was erased");
  }
  return head.corrupt === true ? { erased: true } : { erased: true, documentId: head.documentId };
}
