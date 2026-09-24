/** Sealing, moving, tombstoning and restoring a collaborative note. */

import { eligible } from "./eligibility.js";
import {
  SCHEMA_VERSION,
  fail,
  isObject,
  parseJson,
  put,
  randomId,
  readObject,
  requireSupported,
  structuralKey,
} from "./storage.js";
import { assertTextSize } from "./ydoc.js";
import {
  assertExpectedRevision,
  makeResult,
  putHead,
  readHead,
  readRevision,
  readState,
  readStructural,
  requireConditionalDelete,
  validateState,
  writeStructural,
} from "./records.js";
import { isEncryptedEnvelope, lifecyclePath } from "./admission.js";
import { purgeDocumentState } from "./purge.js";
import { recoverSeal, recoverStructural } from "./structuralRecovery.js";
import { ready } from "./load.js";
import { readDocument } from "./commit.js";

/**
 * Transition a collaborative plaintext note to an already-encrypted Markdown
 * envelope. The envelope is the only note content accepted here: this method
 * never receives or journals plaintext. The structural journal makes every
 * mutation resumable and the final purge removes the old Yjs history while
 * retaining the ciphertext at the user-visible path.
 */
export async function sealDocument(store, path, input) {
  requireSupported(store);
  requireConditionalDelete(store);
  if (typeof store.list !== "function") throw fail("UNSUPPORTED_STORAGE", "sealing requires verified storage listing for history purge");
  if (!eligible(path, "") || !isObject(input) || typeof input.expectedEtag !== "string" || typeof input.text !== "string") {
    throw fail("INVALID_ARGUMENT", "expectedEtag and encrypted envelope are required");
  }
  if (!isEncryptedEnvelope(input.text)) throw fail("INVALID_ARGUMENT", "text must be a valid encrypted Markdown envelope");
  assertTextSize(input.text);

  let head = await readHead(store, path);
  if (head?.status === "sealed") {
    const current = await readObject(store, path);
    if (!current || current.text !== input.text) throw fail("SEAL_CONFLICT", "sealed note does not contain the requested envelope");
    if (head.operationId) {
      const operation = await readStructural(store, head.operationId).catch((error) => {
        if (error?.code === "CORRUPT_STATE") return null;
        throw error;
      });
      if (operation?.value?.kind === "seal") return recoverSeal(store, head.operationId);
    }
    await purgeDocumentState(store, { documentId: head.documentId, generation: head.generation });
    return { documentId: head.documentId, generation: head.generation, sealed: true, etag: current.etag };
  }

  if (head?.status === "sealing" && head.operationId) {
    const operation = await readStructural(store, head.operationId);
    if (operation.value.kind !== "seal" || operation.value.encryptedEnvelope !== input.text || operation.value.expectedEtag !== input.expectedEtag) {
      throw fail("CONFLICT", "another sealing operation is in progress");
    }
    return recoverSeal(store, head.operationId);
  }

  // A crash can land after the state freeze (which records the journal in the
  // document) but before the path head is marked `sealing`. Resume that
  // journal before `ready()` inspects the now-encrypted raw file.
  if (head?.status === "active") {
    const frozen = await readState(store, head);
    const operationId = frozen?.value?.structural?.kind === "seal" ? frozen.value.structural.operationId : null;
    if (operationId) {
      const operation = await readStructural(store, operationId);
      if (operation.value.kind !== "seal" || operation.value.encryptedEnvelope !== input.text || operation.value.expectedEtag !== input.expectedEtag) {
        throw fail("CONFLICT", "another sealing operation is in progress");
      }
      return recoverSeal(store, operationId);
    }
  }

  const loaded = await ready(store, path);
  assertExpectedRevision(loaded.state, input.expectedEtag);
  if (input.documentId !== undefined && input.documentId !== loaded.state.documentId) throw fail("GENERATION_MISMATCH", "document generation does not match");
  head = await readHead(store, path);
  if (!head || head.status !== "active") throw fail("CONFLICT", "document is in another lifecycle transition");

  const operation = {
    schemaVersion: SCHEMA_VERSION,
    kind: "seal",
    operationId: randomId("seal"),
    path,
    documentId: loaded.state.documentId,
    generation: loaded.state.generation,
    stateKey: loaded.head.stateKey,
    expectedEtag: input.expectedEtag,
    expectedRawEtag: loaded.state.rawMarkdownEtag,
    encryptedEnvelope: input.text,
    phase: "started",
  };
  await writeStructural(store, operation);
  const frozen = { ...loaded.state, structural: { kind: "seal", operationId: operation.operationId } };
  const frozenWrite = await put(store, loaded.head.stateKey, JSON.stringify(frozen), { etagMatches: loaded.stateEtag });
  if (!frozenWrite) return sealDocument(store, path, input);
  return recoverSeal(store, operation.operationId);
}

function structuralOperation({ kind, operationId, path, documentId, generation, stateKey, sourceRawEtag, sourceText, initialSnapshot, permanent = false, from, to }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind,
    operationId,
    path,
    from,
    to,
    documentId,
    generation,
    stateKey,
    sourceRawEtag,
    sourceText,
    initialSnapshot,
    permanent,
    phase: "started",
  };
}

async function freezeForStructural(store, loaded, operation) {
  if (loaded.state.structural) {
    if (loaded.state.structural.operationId !== operation.operationId) throw fail("CONFLICT", "another structural operation is in progress");
    return loaded;
  }
  const frozen = { ...loaded.state, structural: { kind: operation.kind, operationId: operation.operationId, ...(operation.to ? { from: operation.from, to: operation.to } : {}) } };
  const written = await put(store, loaded.head.stateKey, JSON.stringify(frozen), { etagMatches: loaded.stateEtag });
  if (!written) throw fail("CONCURRENT_WRITE", "document changed while starting the structural operation");
  return { ...loaded, state: frozen, stateEtag: written.etag };
}

/** Move one note while preserving its document identity and revision history. */
export async function moveDocument(store, from, to, options = {}) {
  requireSupported(store);
  requireConditionalDelete(store);
  if (!lifecyclePath(from, options.internalTrash) || !lifecyclePath(to, options.internalTrash) || from === to) throw fail("INELIGIBLE_DOCUMENT", "move paths must be distinct Markdown notes");
  let sourceHead = await readHead(store, from);
  if (sourceHead?.status === "moved" && !(await readObject(store, from))) throw Object.assign(fail("MOVED", "document moved; reauthorize the destination"), { destination: sourceHead.destination });
  if (sourceHead?.status === "deleted") throw fail("DELETED", "document generation is deleted");
  const loaded = await ready(store, from);
  assertExpectedRevision(loaded.state, options.expectedEtag);
  sourceHead = await readHead(store, from);
  const destinationHead = await readHead(store, to);
  const destinationObject = await readObject(store, to);
  const returning = destinationHead?.status === "moved" && destinationHead.documentId === loaded.state.documentId && destinationHead.destination === from;
  if ((destinationHead && !returning) || destinationObject) throw fail("DESTINATION_EXISTS", "destination path already exists");
  const operation = structuralOperation({
    kind: "move",
    operationId: randomId("move"),
    from,
    to,
    documentId: loaded.state.documentId,
    generation: loaded.state.generation,
    stateKey: loaded.head.stateKey,
    sourceRawEtag: loaded.state.rawMarkdownEtag,
    sourceText: loaded.state.text,
    initialSnapshot: sourceHead.initialSnapshot,
  });
  await writeStructural(store, operation);
  await freezeForStructural(store, loaded, operation);
  const moving = await putHead(store, from, { ...sourceHead, status: "moving", operationId: operation.operationId, destination: to }, sourceHead.etag);
  if (!moving) return moveDocument(store, from, to, options);
  const outcome = await recoverStructural(store, operation.operationId);
  if (outcome?.aborted) throw fail("DESTINATION_EXISTS", outcome.reason || "destination path changed during the move");
  const destination = await ready(store, to);
  const result = makeResult(destination.state, destination.revision);
  return { ...result, from, to };
}

/** Tombstone a note while retaining its CRDT history for a later restore. */
export async function tombstoneDocument(store, path, options = {}) {
  requireSupported(store);
  requireConditionalDelete(store);
  const existingHead = await readHead(store, path);
  if (existingHead?.status === "deleting" && existingHead.operationId) {
    await recoverStructural(store, existingHead.operationId);
    return tombstoneDocument(store, path, options);
  }
  if (existingHead && existingHead.status !== "deleted") {
    const existingState = await readState(store, existingHead);
    const structural = existingState?.value?.structural;
    if (structural?.kind === "delete") {
      await recoverStructural(store, structural.operationId);
      return tombstoneDocument(store, path, options);
    }
  }
  if (existingHead?.status === "deleted") {
    if (options.permanent === true) {
      const structural = existingHead.operationId && await readObject(store, structuralKey(existingHead.operationId));
      if (structural) {
        const operation = parseJson(structural.text, "structural operation");
        if (operation.phase !== "complete") await recoverStructural(store, existingHead.operationId);
        await purgeDocumentState(store, { ...operation, permanent: true });
      } else {
        await purgeDocumentState(store, {
          schemaVersion: SCHEMA_VERSION,
          kind: "delete",
          operationId: randomId("purge"),
          documentId: existingHead.documentId,
          generation: existingHead.generation,
          permanent: true,
        });
      }
    }
    return { documentId: existingHead.documentId, generation: existingHead.generation, deleted: true };
  }
  const loaded = await ready(store, path);
  assertExpectedRevision(loaded.state, options.expectedEtag);
  const head = await readHead(store, path);
  const operation = structuralOperation({
    kind: "delete",
    operationId: randomId("delete"),
    path,
    documentId: loaded.state.documentId,
    generation: loaded.state.generation,
    stateKey: loaded.head.stateKey,
    sourceRawEtag: loaded.state.rawMarkdownEtag,
    sourceText: loaded.state.text,
    initialSnapshot: head.initialSnapshot,
    permanent: options.permanent === true,
  });
  await writeStructural(store, operation);
  await freezeForStructural(store, loaded, operation);
  const deleting = await putHead(store, path, { ...head, status: "deleting", operationId: operation.operationId }, head.etag);
  if (!deleting) return tombstoneDocument(store, path, options);
  const outcome = await recoverStructural(store, operation.operationId);
  if (outcome?.aborted) throw fail("CONFLICT", outcome.reason || "Markdown changed during deletion");
  return { documentId: operation.documentId, generation: operation.generation, deleted: true };
}

/** Restore a retained tombstone under its original path with the same identity. */
export async function restoreDocument(store, path, options = {}) {
  requireSupported(store);
  requireConditionalDelete(store);
  const head = await readHead(store, path);
  if (!head || head.status !== "deleted") throw fail("NOT_DELETED", "document is not a tombstone");
  const stateRecord = await readState(store, head);
  if (!stateRecord) throw fail("RESTORE_UNAVAILABLE", "deleted document history is no longer retained");
  const state = validateState(stateRecord.value, { documentId: head.documentId, generation: head.generation }, path);
  assertExpectedRevision(state, options.expectedEtag);
  if (await readObject(store, path)) throw fail("CONFLICT", "restore path was recreated by another writer");
  const retainedRevision = await readRevision(store, state.documentId, state.revision);
  const operation = structuralOperation({
    kind: "restore",
    operationId: randomId("restore"),
    path,
    documentId: head.documentId,
    generation: head.generation,
    stateKey: head.stateKey,
    sourceRawEtag: state.rawMarkdownEtag,
    sourceText: state.text,
    initialSnapshot: retainedRevision.value.snapshot,
  });
  await writeStructural(store, operation);
  const frozen = { ...state, structural: { kind: "restore", operationId: operation.operationId } };
  const frozenWrite = await put(store, head.stateKey, JSON.stringify(frozen), { etagMatches: stateRecord.etag });
  if (!frozenWrite) return restoreDocument(store, path, options);
  const restoring = await putHead(store, path, { ...head, status: "restoring", operationId: operation.operationId }, head.etag);
  if (!restoring) return restoreDocument(store, path, options);
  const outcome = await recoverStructural(store, operation.operationId);
  if (outcome?.aborted) throw fail("CONFLICT", outcome.reason || "restore path changed during recovery");
  return readDocument(store, path);
}
