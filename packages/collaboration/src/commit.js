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
} from "./storage.js";
import {
  applyUpdateTo,
  assertTextSize,
  assertUpdateBytes,
  docFromSnapshot,
  hasPendingDependencies,
  snapshotOf,
} from "./ydoc.js";
import { inlineRevision, makeResult, readHead, writeRevision } from "./records.js";
import { basesWith, idleSince } from "./versions.js";
import { finalizePending, ready } from "./load.js";

/** Read the current Yjs snapshot and the Markdown etag it materializes. */
export async function readDocument(store, path, headRead = null) {
  requireSupported(store);
  if (!eligible(path, "")) throw fail("INELIGIBLE_DOCUMENT", "document is not eligible for collaboration");
  const loaded = await ready(store, path, headRead);
  if (loaded.state.deferredUpdates.length > 0) {
    throw fail("DEPENDENCY_PENDING", "accepted Yjs updates are waiting for missing dependencies");
  }
  return makeResult(loaded.state, loaded.revision);
}

/**
 * Whether `path` has a collaboration document: a head, live or deleted. A note
 * with none has never been opened or saved through the engine, so no editor or
 * device holds a copy of it to merge with.
 */
export async function documentStarted(store, path) {
  requireSupported(store);
  return (await readHead(store, path)) !== null;
}

/**
 * `readDocument` for a reader that only looks: the document when this path
 * already has collaboration state, or `null` when it has none, without
 * creating any. A note nothing has edited collaboratively has no head, and
 * its Markdown is then the only state there is, so a reader may serve it as
 * it is. Starting a document is ~15 storage calls (head, state, seed revision,
 * re-reads to refuse races), which a caller that only reads need not pay: a
 * check-in that read 35 inbox notes spent ~500 of its invocation's
 * subrequests seeding documents nobody would edit.
 *
 * A later write still works against the Markdown etag that reader was given:
 * the write starts the document over the Markdown as it then is, and its
 * `legacyRawEtag` is that same etag (`replaceText`), so an unchanged base
 * merges and a changed one is a conflict, as it would have been.
 */
export async function readDocumentIfStarted(store, path) {
  requireSupported(store);
  if (!eligible(path, "")) throw fail("INELIGIBLE_DOCUMENT", "document is not eligible for collaboration");
  const head = await readHead(store, path, { pathHeadTogether: true });
  if (head === null) return null;
  return readDocument(store, path, head);
}

export async function commitSnapshot(store, path, loaded, documentId, nextDoc) {
  if (documentId !== loaded.state.documentId) throw fail("GENERATION_MISMATCH", "document generation does not match");
  const nextText = nextDoc.getText("note").toString();
  assertTextSize(nextText);
  const nextSnapshot = snapshotOf(nextDoc);
  if (nextSnapshot === loaded.revision.value.snapshot) return makeResult(loaded.state, loaded.revision);
  const now = Date.now();
  const nextRevision = randomId("r");
  // No revision file: the state carries the snapshot, and a marker finds this revision again as a merge base
  // (`versions.js`). A version file is kept only when the person goes idle, below.
  const next = {
    ...loaded.state,
    revision: nextRevision,
    text: nextText,
    pending: { revision: nextRevision, previousRevision: loaded.state.revision, previousRawEtag: loaded.state.rawMarkdownEtag, text: nextText },
    deferredUpdates: [],
    current: { revision: nextRevision, snapshot: nextSnapshot, rawMarkdownEtag: loaded.state.rawMarkdownEtag },
    bases: basesWith(loaded.state, nextRevision, nextDoc, loaded.revision.value.snapshot),
    editedAt: now,
  };
  const written = await put(store, loaded.head.stateKey, JSON.stringify(next), { etagMatches: loaded.stateEtag });
  if (!written) return null;
  const finalized = await finalizePending(store, path, {
    head: loaded.head,
    state: next,
    stateEtag: written.etag,
    revision: inlineRevision(next),
  }, { committed: true });
  if (idleSince(loaded.state, now)) await keepIdleVersion(store, loaded.revision.value);
  return makeResult(finalized.state, finalized.revision);
}

/**
 * Keep the state a person stopped at, before a save that came after they went idle, as a version file. The save is
 * already accepted and rendered, so a failure here is not the save's: it only leaves that version unkept.
 */
async function keepIdleVersion(store, revision) {
  try {
    await writeRevision(store, revision);
  } catch {
    // The version is a convenience on top of a durable save; never fail the save for it.
  }
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
