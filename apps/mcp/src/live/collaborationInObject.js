/**
 * The editor's live reads and saves (`/collaboration`, `collaborationRoute.js`) run by the engine inside the note's
 * workspace object, in one call each, where the object holds the note whole.
 *
 * Until 2026-11-11 the gateway ran the engine here, against the object, one storage call at a time over the network,
 * while other readers did the same: two engines interleaving on one history is how a read came to give up in the
 * middle of somebody's typing (Dev2, 2026-11-11; `docs/decisions/collaboration.md`). The object takes one call at a
 * time, so an edit, a read and a replacement there cannot interleave.
 *
 * Each function answers what the engine would have answered, and throws what it would have thrown. Where the object
 * does not serve the note (a workspace not on its object yet, a Tex note, a row that moved on the way) the engine runs
 * through the store, as before. A commit that failed on the way is run here too: a Yjs update applied twice is the
 * same document, so it can never be counted twice.
 */

import {
  CollaborationError,
  commitUpdate,
  readDocument,
  replaceText,
} from "@context/collaboration";

const refusal = (error) => new CollaborationError(String(error?.code ?? "STORAGE_WRITE_FAILED"), String(error?.message ?? "collaboration failed"));

/** The note's document as the editor reads it (`readDocument`), started if nothing has edited it together yet. */
export async function readLiveDocument(store, path) {
  const view = typeof store?.oneRead === "function" ? store.oneRead(store) : store;
  if (typeof view?.readInObject === "function") {
    let answer = null;
    try {
      answer = await view.readInObject(path, { start: true, whole: true });
    } catch {
      answer = null;
    }
    if (answer?.error) throw refusal(answer.error);
    if (answer?.collaboration && typeof answer.collaboration.update === "string") return answer.collaboration;
  }
  return await readDocument(store, path);
}

/** One live edit (`commitUpdate`). */
export async function commitLiveUpdate(store, path, input) {
  if (typeof store?.commitInObject === "function") {
    let answer = null;
    try {
      answer = await store.commitInObject(path, { documentId: input.documentId, update: input.update });
    } catch {
      answer = null;
    }
    if (answer?.served === true) {
      if (answer.error) throw refusal(answer.error);
      if (answer.result && typeof answer.result === "object") return answer.result;
    }
  }
  return await commitUpdate(store, path, input);
}

/**
 * The editor's whole-text replacement against the exact version it holds (`replaceText` without `onlyCurrent`: the
 * console keeps its exact-base merge). Only a call the object declined runs the engine here: one that failed on the way
 * may have landed, and the editor's own retry is the one place that resends it.
 */
export async function replaceLiveText(store, path, input) {
  if (typeof store?.replaceInObject === "function") {
    const answer = await store.replaceInObject(path, { expectedEtag: input.expectedEtag, text: input.text, onlyCurrent: false });
    if (answer?.served === true) {
      if (answer.error) throw refusal(answer.error);
      if (answer.result && typeof answer.result === "object") return answer.result;
    }
  }
  return await replaceText(store, path, input);
}
