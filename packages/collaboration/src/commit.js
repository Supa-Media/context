/** Reading the current document and committing a Yjs update to it. */

import { eligible } from "./eligibility.js";
import {
  MAX_RETRIES,
  base64ToBytes,
  fail,
  isObject,
  put,
  randomId,
  requireSupported,
  revisionKey,
} from "./storage.js";
import {
  applyUpdateTo,
  assertTextSize,
  assertUpdateBytes,
  docFromSnapshot,
  hasPendingDependencies,
  snapshotOf,
} from "./ydoc.js";
import { makeResult, writeRevision } from "./records.js";
import { finalizePending, ready } from "./load.js";

/** Read the current Yjs snapshot and the Markdown etag it materializes. */
export async function readDocument(store, path) {
  requireSupported(store);
  if (!eligible(path, "")) throw fail("INELIGIBLE_DOCUMENT", "document is not eligible for collaboration");
  const loaded = await ready(store, path);
  if (loaded.state.deferredUpdates.length > 0) {
    throw fail("DEPENDENCY_PENDING", "accepted Yjs updates are waiting for missing dependencies");
  }
  return makeResult(loaded.state, loaded.revision);
}

export async function commitSnapshot(store, path, loaded, documentId, nextDoc) {
  if (documentId !== loaded.state.documentId) throw fail("GENERATION_MISMATCH", "document generation does not match");
  const nextText = nextDoc.getText("note").toString();
  assertTextSize(nextText);
  const nextSnapshot = snapshotOf(nextDoc);
  if (nextSnapshot === loaded.revision.value.snapshot) return makeResult(loaded.state, loaded.revision);
  const nextRevision = randomId("r");
  const revision = {
    documentId: loaded.state.documentId,
    generation: loaded.state.generation,
    revision: nextRevision,
    snapshot: nextSnapshot,
    text: nextText,
    rawMarkdownEtag: loaded.state.rawMarkdownEtag,
  };
  await writeRevision(store, revision);
  const next = {
    ...loaded.state,
    revision: nextRevision,
    text: nextText,
    pending: { revision: nextRevision, previousRevision: loaded.state.revision, previousRawEtag: loaded.state.rawMarkdownEtag, text: nextText },
    deferredUpdates: [],
  };
  const written = await put(store, loaded.head.stateKey, JSON.stringify(next), { etagMatches: loaded.stateEtag });
  if (!written) {
    // This revision was never accepted by the document CAS. In particular a
    // permanent deletion may have won while its upload was in flight. Remove
    // our unique, unpublished candidate rather than leaving deleted content
    // behind after the purge. An uncertain CAS result is deliberately not
    // cleaned up here: only a definitive rejected condition proves it unused.
    if (typeof store.delete === "function") await store.delete(revisionKey(revision.documentId, revision.revision));
    return null;
  }
  const finalized = await finalizePending(store, path, {
    head: loaded.head,
    state: next,
    stateEtag: written.etag,
    revision: { value: revision },
  });
  return makeResult(finalized.state, finalized.revision);
}

/** Commit an opaque Yjs update against the stable document generation. */
export async function commitUpdate(store, path, input) {
  requireSupported(store);
  if (!eligible(path, "")) throw fail("INELIGIBLE_DOCUMENT", "document is not eligible for collaboration");
  if (!isObject(input) || typeof input.documentId !== "string") throw fail("INVALID_ARGUMENT", "documentId is required");
  let loaded = await ready(store, path);
  if (loaded.state.documentId !== input.documentId) throw fail("GENERATION_MISMATCH", "document generation does not match");
  const bytes = base64ToBytes(input.update);
  assertUpdateBytes(bytes);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    if (loaded.state.documentId !== input.documentId) throw fail("GENERATION_MISMATCH", "document generation does not match");
    const doc = docFromSnapshot(loaded.revision.value.snapshot);
    for (const deferred of loaded.state.deferredUpdates) applyUpdateTo(doc, base64ToBytes(deferred));
    const delta = applyUpdateTo(doc, bytes);
    if (hasPendingDependencies(doc)) {
      const deferredUpdates = [...loaded.state.deferredUpdates];
      if (!deferredUpdates.includes(input.update)) deferredUpdates.push(input.update);
      const next = { ...loaded.state, deferredUpdates };
      const written = await put(store, loaded.head.stateKey, JSON.stringify(next), { etagMatches: loaded.stateEtag });
      if (written) {
        // This is an explicit durable-pending response, never a saved ACK: the
        // caller must retain its local queue until a later dependency-complete
        // update returns applied=true.
        return { ...makeResult(loaded.state, loaded.revision), applied: false, pendingDependencies: true };
      }
      loaded = await ready(store, path);
      continue;
    }
    if (delta.byteLength === 0 && loaded.state.deferredUpdates.length === 0) return makeResult(loaded.state, loaded.revision);
    const result = await commitSnapshot(store, path, loaded, input.documentId, doc);
    if (result) return result;
    loaded = await ready(store, path);
  }
  throw fail("CONCURRENT_WRITE", "collaboration state kept changing during commit");
}
