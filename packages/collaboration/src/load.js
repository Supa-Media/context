/**
 * Loading a note's collaboration generation: initializing it, recreating it
 * after a lifecycle change, and finishing any accepted state that has not yet
 * reached Markdown.
 */

import { eligible } from "./eligibility.js";
import {
  MAX_RETRIES,
  SCHEMA_VERSION,
  documentKey,
  fail,
  headKey,
  put,
  randomId,
  readObject,
  structuralKey,
} from "./storage.js";
import { assertTextSize, docFromSnapshot, newDoc, snapshotOf } from "./ydoc.js";
import {
  readHead,
  readRevision,
  readState,
  scrubHeadSeed,
  stateObject,
  validateState,
  writeRevision,
} from "./records.js";
import { assertEligible, isEncryptedEnvelope } from "./admission.js";
import { recoverStructural } from "./structuralRecovery.js";

async function initialize(store, path, note, head) {
  if (head) {
    if (head.status !== "active") throw fail("GENERATION_MISMATCH", "document generation is unavailable");
    let stored = await readState(store, head);
    if (!stored) {
      if (typeof head.initialEtag !== "string" || typeof head.initialText !== "string" || typeof head.initialSnapshot !== "string") {
        throw fail("CORRUPT_STATE", "collaboration initialization seed is missing");
      }
      const current = await readObject(store, path);
      if (!current || current.etag !== head.initialEtag || current.text !== head.initialText) {
        throw fail("INITIALIZATION_CONFLICT", "the note changed while collaboration was initializing");
      }
      const doc = docFromSnapshot(head.initialSnapshot);
      if (doc.getText("note").toString() !== head.initialText) throw fail("CORRUPT_STATE", "collaboration path head seed does not match Markdown");
      const state = stateObject({
        documentId: head.documentId,
        generation: head.generation,
        path,
        text: head.initialText,
        rawMarkdownEtag: head.initialEtag,
      });
      const revision = {
        documentId: head.documentId,
        generation: head.generation,
        revision: "r0",
        snapshot: head.initialSnapshot,
        text: head.initialText,
        rawMarkdownEtag: head.initialEtag,
      };
      await writeRevision(store, revision);
      const written = await put(store, head.stateKey, JSON.stringify(state), { absent: true });
      if (!written) stored = await readState(store, head);
      else stored = { value: state, etag: written.etag };
    }
    if (!stored) throw fail("CORRUPT_STATE", "collaboration document state disappeared during initialization");
    const currentHead = await scrubHeadSeed(store, head);
    return { head: currentHead || head, state: validateState(stored.value, head, path), stateEtag: stored.etag };
  }

  const documentId = randomId("doc");
  const generation = randomId("generation");
  const seed = newDoc();
  seed.getText("note").insert(0, note.text);
  const candidate = {
    schemaVersion: SCHEMA_VERSION,
    path,
    documentId,
    generation,
    stateKey: documentKey(documentId),
    initialEtag: note.etag,
    initialText: note.text,
    initialSnapshot: snapshotOf(seed),
    status: "active",
  };
  const writtenHead = await put(store, await headKey(path), JSON.stringify(candidate), { absent: true });
  if (!writtenHead) return null;

  // A legacy writer can mutate Markdown between our first read and claiming the
  // head. Re-read before creating the document state and refuse that race.
  const reread = await readObject(store, path);
  if (!reread || reread.etag !== note.etag || reread.text !== note.text) {
    throw fail("INITIALIZATION_CONFLICT", "the note changed while collaboration was initializing");
  }
  return initialize(store, path, note, { ...candidate, etag: writtenHead.etag });
}

async function recreateGeneration(store, path, note, tombstone) {
  const seed = newDoc();
  seed.getText("note").insert(0, note.text);
  const documentId = randomId("doc");
  const candidate = {
    schemaVersion: SCHEMA_VERSION,
    path,
    documentId,
    generation: randomId("generation"),
    stateKey: documentKey(documentId),
    initialEtag: note.etag,
    initialText: note.text,
    initialSnapshot: snapshotOf(seed),
    status: "active",
  };
  const written = await put(store, await headKey(path), JSON.stringify(candidate), { etagMatches: tombstone.etag });
  if (!written) return load(store, path);
  return initialize(store, path, note, { ...candidate, etag: written.etag });
}

async function load(store, path) {
  const head = await readHead(store, path);
  if (head?.status === "sealed") {
    const sealed = await readObject(store, path);
    if (!sealed) throw fail("DOCUMENT_MISSING", "sealed Markdown note is missing");
    // Ciphertext remains ineligible. An authorized raw decrypt is a new
    // plaintext transition and must receive a new collaboration generation,
    // so offline updates from the sealed generation cannot reattach.
    if (isEncryptedEnvelope(sealed.text)) throw fail("INELIGIBLE_DOCUMENT", "encrypted notes are not eligible for collaboration");
    assertEligible(path, sealed.text);
    assertTextSize(sealed.text);
    return recreateGeneration(store, path, sealed, head);
  }
  if (head?.status === "moved") {
    const recreated = await readObject(store, path);
    if (!recreated) throw Object.assign(fail("MOVED", "document moved; reauthorize the destination"), { destination: head.destination });
    assertEligible(path, recreated.text);
    assertTextSize(recreated.text);
    return recreateGeneration(store, path, recreated, head);
  }
  if (head?.status === "deleted") {
    if (head.operationId) {
      const structural = await readObject(store, structuralKey(head.operationId));
      if (structural) await recoverStructural(store, head.operationId);
    }
    const recreated = await readObject(store, path);
    if (!recreated) throw fail("DELETED", "document generation is deleted");
    assertEligible(path, recreated.text);
    assertTextSize(recreated.text);
    return recreateGeneration(store, path, recreated, head);
  }
  if (head && ["moving", "prepared", "deleting", "restoring", "sealing"].includes(head.status)) {
    await recoverStructural(store, head.operationId);
    const settled = await readHead(store, path);
    if (settled && settled.etag === head.etag && settled.status === head.status && settled.operationId === head.operationId) {
      throw fail("STRUCTURAL_PENDING", "collaboration structural recovery did not advance the path head");
    }
    return load(store, path);
  }
  const note = await readObject(store, path);
  if (!note) throw fail("DOCUMENT_MISSING", "collaboration requires an existing Markdown note");
  assertEligible(path, note.text);
  assertTextSize(note.text);
  const initialized = await initialize(store, path, note, head);
  if (initialized) return initialized;
  return load(store, path);
}

async function reload(store, path) {
  const head = await readHead(store, path);
  if (!head || head.deleted) throw fail("GENERATION_MISMATCH", "document generation is unavailable");
  const stored = await readState(store, head);
  if (!stored) return load(store, path);
  return { head, state: validateState(stored.value, head, path), stateEtag: stored.etag };
}

export async function finalizePending(store, path, loaded) {
  let current = loaded;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const { state, stateEtag, head } = current;
    const revision = await readRevision(store, state.documentId, state.revision);
    if (!state.pending) {
      const note = await readObject(store, path);
      if (!note) throw fail("DOCUMENT_MISSING", "Markdown note disappeared during materialization");
      if (note.etag === state.rawMarkdownEtag) {
        if (note.text !== revision.value.text || note.text !== state.text) throw fail("MATERIALIZATION_CONFLICT", "Markdown changed outside collaboration");
        return { ...current, revision };
      }
      if (!eligible(path, note.text)) throw fail("MATERIALIZATION_CONFLICT", "the Markdown generation is no longer eligible for collaboration");
      const repaired = await put(store, path, revision.value.text, { etagMatches: note.etag });
      if (!repaired) {
        current = await reload(store, path);
        continue;
      }
      const repairedNote = await readObject(store, path);
      if (!repairedNote || repairedNote.text !== revision.value.text) throw fail("MATERIALIZATION_CONFLICT", "Markdown repair did not reflect the accepted state");
      const reconciled = {
        ...state,
        rawMarkdownEtag: repairedNote.etag,
      };
      const written = await put(store, head.stateKey, JSON.stringify(reconciled), { etagMatches: stateEtag });
      if (written) return { head, state: reconciled, stateEtag: written.etag, revision };
      current = await reload(store, path);
      continue;
    }

    const pending = state.pending;
    const pendingRevision = await readRevision(store, state.documentId, pending.revision);
    const note = await readObject(store, path);
    if (!note) throw fail("DOCUMENT_MISSING", "Markdown note disappeared during materialization");
    let materialized = note;
    if (note.etag === pending.previousRawEtag) {
      const written = await put(store, path, pending.text, { etagMatches: pending.previousRawEtag });
      if (!written) {
        current = await reload(store, path);
        continue;
      }
      materialized = await readObject(store, path);
      if (!materialized || materialized.etag !== written.etag || materialized.text !== pending.text) {
        throw fail("MATERIALIZATION_CONFLICT", "Markdown did not reflect the accepted collaboration state");
      }
    } else if (note.text !== pending.text) {
      if (!eligible(path, note.text)) throw fail("MATERIALIZATION_CONFLICT", "the Markdown generation is no longer eligible for collaboration");
      const repaired = await put(store, path, pending.text, { etagMatches: note.etag });
      if (!repaired) {
        current = await reload(store, path);
        continue;
      }
      materialized = await readObject(store, path);
      if (!materialized || materialized.text !== pending.text) throw fail("MATERIALIZATION_CONFLICT", "Markdown repair did not reflect the accepted state");
    }

    const next = {
      ...state,
      revision: pending.revision,
      text: pendingRevision.value.text,
      rawMarkdownEtag: materialized.etag,
      pending: null,
    };
    const recorded = await put(store, head.stateKey, JSON.stringify(next), { etagMatches: stateEtag });
    if (recorded) return { head, state: next, stateEtag: recorded.etag, revision: pendingRevision };
    current = await reload(store, path);
  }
  throw fail("MATERIALIZATION_PENDING", "accepted collaboration state is durable and still awaiting Markdown materialization");
}

export async function ready(store, path) {
  let current = await load(store, path);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    if (current.state.structural) {
      await recoverStructural(store, current.state.structural.operationId);
      current = await load(store, path);
      continue;
    }
    const finalized = await finalizePending(store, path, current);
    if (finalized.state.pending) {
      current = await reload(store, path);
      continue;
    }
    return finalized;
  }
  throw fail("MATERIALIZATION_PENDING", "accepted collaboration state is still pending");
}
