/** Resuming delete, restore and seal journals, and dispatching any journal. */

import { SCHEMA_VERSION, fail, put, readObject } from "./storage.js";
import {
  identityHead,
  putHead,
  readHead,
  readRevision,
  readState,
  readStructural,
  updateStructural,
  validateState,
} from "./records.js";
import { purgeDocumentState, scrubStructural } from "./purge.js";
import { finishAbortedMove, recoverMove } from "./moveRecovery.js";

async function recoverDelete(store, operationId) {
  const opRecord = await readStructural(store, operationId);
  const op = opRecord.value;
  let head = await readHead(store, op.path);
  const stateRecord = await readState(store, { stateKey: op.stateKey, documentId: op.documentId, generation: op.generation });
  if (!stateRecord) throw fail("CORRUPT_STATE", "deleted document state is missing");
  const state = validateState(stateRecord.value, { documentId: op.documentId, generation: op.generation }, op.path);
  // A crash can occur after the state freeze but before the path head records
  // `deleting`. The journal is authoritative in that window; claim the head
  // before removing Markdown so recovery cannot strand an active missing path.
  if (head?.status === "active" && head.documentId === op.documentId && head.generation === op.generation) {
    const marked = await putHead(store, op.path, identityHead(head, "deleting", { operationId }), head.etag);
    if (!marked) return recoverDelete(store, operationId);
    head = await readHead(store, op.path);
  }
  const object = await readObject(store, op.path);
  if (object) {
    if (object.etag !== op.sourceRawEtag || object.text !== op.sourceText) {
      return abortDelete(store, opRecord, "Markdown changed during deletion");
    }
    const removed = await store.delete(op.path, { onlyIf: { etagMatches: op.sourceRawEtag } });
    if (removed === null) return recoverDelete(store, operationId);
    if (await readObject(store, op.path)) return recoverDelete(store, operationId);
  }
  let nextState = state;
  if (state.structural?.operationId === operationId) {
    nextState = { ...state, structural: null, rawMarkdownEtag: "deleted" };
    const written = await put(store, op.stateKey, JSON.stringify(nextState), { etagMatches: stateRecord.etag });
    if (!written) return recoverDelete(store, operationId);
  }
  const current = await readHead(store, op.path);
  if (current?.status === "deleting") {
    const tombstone = {
      schemaVersion: SCHEMA_VERSION,
      path: op.path,
      documentId: op.documentId,
      generation: op.generation,
      stateKey: op.stateKey,
      status: "deleted",
      operationId,
    };
    const written = await putHead(store, op.path, tombstone, current.etag);
    if (!written) return recoverDelete(store, operationId);
  }
  await updateStructural(store, { ...op, phase: "complete" }, opRecord.etag);
  if (op.permanent) await purgeDocumentState(store, op, nextState);
  else await scrubStructural(store, operationId);
  return { ...nextState, deleted: true };
}

/** Roll back a delete that encountered a concurrent legacy Markdown change. */
async function abortDelete(store, opRecord, reason) {
  const op = opRecord.value;
  const stateRecord = await readState(store, { stateKey: op.stateKey, documentId: op.documentId, generation: op.generation });
  if (stateRecord?.value?.structural?.operationId === op.operationId) {
    const cleared = { ...stateRecord.value, structural: null };
    const written = await put(store, op.stateKey, JSON.stringify(cleared), { etagMatches: stateRecord.etag });
    if (!written) {
      const latest = await readState(store, { stateKey: op.stateKey, documentId: op.documentId, generation: op.generation });
      if (latest?.value?.structural?.operationId === op.operationId) return abortDelete(store, opRecord, reason);
    }
  }
  const head = await readHead(store, op.path);
  if (head?.status === "deleting" && head.operationId === op.operationId) {
    const active = identityHead(head, "active");
    const restored = await putHead(store, op.path, active, head.etag);
    if (!restored) return abortDelete(store, opRecord, reason);
  }
  await updateStructural(store, { ...op, phase: "aborted", abortedReason: reason }, opRecord.etag);
  return { aborted: true, reason };
}

async function recoverRestore(store, operationId) {
  const opRecord = await readStructural(store, operationId);
  const op = opRecord.value;
  const head = await readHead(store, op.path);
  const stateRecord = await readState(store, { stateKey: op.stateKey, documentId: op.documentId, generation: op.generation });
  if (!stateRecord) throw fail("RESTORE_UNAVAILABLE", "deleted document history is no longer retained");
  const state = validateState(stateRecord.value, { documentId: op.documentId, generation: op.generation }, op.path);
  const revision = await readRevision(store, op.documentId, state.revision);
  let object = await readObject(store, op.path);
  if (object && object.text !== revision.value.text) {
    return abortRestore(store, opRecord, "restore path was recreated by another writer");
  }
  if (!object) {
    const written = await put(store, op.path, revision.value.text, { absent: true });
    if (!written) return recoverRestore(store, operationId);
    object = await readObject(store, op.path);
  }
  const nextState = { ...state, rawMarkdownEtag: object.etag, structural: null };
  if (state.structural?.operationId === operationId) {
    const written = await put(store, op.stateKey, JSON.stringify(nextState), { etagMatches: stateRecord.etag });
    if (!written) return recoverRestore(store, operationId);
  }
  if (head?.status === "restoring") {
    const active = identityHead(head, "active");
    const written = await putHead(store, op.path, active, head.etag);
    if (!written) return recoverRestore(store, operationId);
  }
  await updateStructural(store, { ...op, phase: "complete" }, opRecord.etag);
  await scrubStructural(store, operationId);
  return nextState;
}

/** Roll back a restore if its path is claimed by a different Markdown writer. */
async function abortRestore(store, opRecord, reason) {
  const op = opRecord.value;
  const stateRecord = await readState(store, { stateKey: op.stateKey, documentId: op.documentId, generation: op.generation });
  if (stateRecord?.value?.structural?.operationId === op.operationId) {
    const cleared = { ...stateRecord.value, structural: null };
    const written = await put(store, op.stateKey, JSON.stringify(cleared), { etagMatches: stateRecord.etag });
    if (!written) {
      const latest = await readState(store, { stateKey: op.stateKey, documentId: op.documentId, generation: op.generation });
      if (latest?.value?.structural?.operationId === op.operationId) return abortRestore(store, opRecord, reason);
    }
  }
  const head = await readHead(store, op.path);
  if (head?.status === "restoring" && head.operationId === op.operationId) {
    const deleted = {
      schemaVersion: SCHEMA_VERSION,
      path: op.path,
      documentId: op.documentId,
      generation: op.generation,
      stateKey: op.stateKey,
      status: "deleted",
      operationId: op.operationId,
    };
    const restored = await putHead(store, op.path, deleted, head.etag);
    if (!restored) return abortRestore(store, opRecord, reason);
  }
  await updateStructural(store, { ...op, phase: "aborted", abortedReason: reason }, opRecord.etag);
  return { aborted: true, reason };
}

/** Resume an encryption transition from its content-free structural journal. */
export async function recoverSeal(store, operationId) {
  const opRecord = await readStructural(store, operationId);
  const op = opRecord.value;
  if (op.phase === "aborted") return { aborted: true, reason: op.abortedReason };
  const head = await readHead(store, op.path);
  if (!head || head.documentId !== op.documentId || head.generation !== op.generation) {
    throw fail("GENERATION_MISMATCH", "sealed document generation is unavailable");
  }
  const current = await readObject(store, op.path);
  if (head.status === "sealed") {
    if (!current || current.text !== op.encryptedEnvelope) throw fail("SEAL_CONFLICT", "sealed note does not contain the requested envelope");
    await purgeDocumentState(store, op);
    return { sealed: true, documentId: op.documentId, generation: op.generation, etag: current.etag };
  }
  if (!current) throw fail("DOCUMENT_MISSING", "Markdown note disappeared during sealing");

  const stateRecord = await readState(store, { stateKey: op.stateKey, documentId: op.documentId, generation: op.generation });
  if (stateRecord) {
    const state = validateState(stateRecord.value, head, op.path);
    if (state.structural === null) {
      const frozen = { ...state, structural: { kind: "seal", operationId } };
      const written = await put(store, op.stateKey, JSON.stringify(frozen), { etagMatches: stateRecord.etag });
      if (!written) return recoverSeal(store, operationId);
    } else if (state.structural.operationId !== operationId) {
      throw fail("CONFLICT", "another structural operation is in progress");
    }
  }

  const latestHead = await readHead(store, op.path);
  if (!latestHead) throw fail("GENERATION_MISMATCH", "sealed document generation is unavailable");
  if (latestHead.status === "active") {
    const marked = await putHead(store, op.path, { ...latestHead, status: "sealing", operationId }, latestHead.etag);
    if (!marked) return recoverSeal(store, operationId);
    return recoverSeal(store, operationId);
  }
  if (latestHead.status !== "sealing") throw fail("CONFLICT", "document is in another lifecycle transition");

  let materialized = current;
  if (current.text !== op.encryptedEnvelope) {
    if (current.etag !== op.expectedRawEtag) throw fail("CONFLICT", "note changed while sealing");
    const written = await put(store, op.path, op.encryptedEnvelope, { etagMatches: op.expectedRawEtag });
    if (!written) return recoverSeal(store, operationId);
    materialized = await readObject(store, op.path);
  }
  if (!materialized || materialized.text !== op.encryptedEnvelope) throw fail("SEAL_CONFLICT", "ciphertext did not persist");

  const sealedHead = identityHead(latestHead, "sealed", { operationId });
  const sealed = await putHead(store, op.path, sealedHead, latestHead.etag);
  if (!sealed) return recoverSeal(store, operationId);
  const completed = { ...op, phase: "complete" };
  await updateStructural(store, completed, opRecord.etag);
  await purgeDocumentState(store, completed);
  return { sealed: true, documentId: op.documentId, generation: op.generation, etag: materialized.etag };
}

export async function recoverStructural(store, operationId) {
  if (typeof operationId !== "string" || !operationId) throw fail("CORRUPT_STATE", "structural operation id is missing");
  const opRecord = await readStructural(store, operationId);
  const op = opRecord.value;
  if (op.phase === "aborted") {
    if (op.kind === "move") return finishAbortedMove(store, opRecord);
    return { aborted: true, reason: op.abortedReason };
  }
  if (op.phase === "complete") {
    if (op.kind === "delete" && op.permanent) await purgeDocumentState(store, op);
    else if (op.kind === "seal") return recoverSeal(store, operationId);
    else await scrubStructural(store, operationId);
    return;
  }
  if (op.kind === "move") return recoverMove(store, operationId);
  if (op.kind === "delete") return recoverDelete(store, operationId);
  if (op.kind === "restore") return recoverRestore(store, operationId);
  if (op.kind === "seal") return recoverSeal(store, operationId);
  throw fail("CORRUPT_STATE", "unsupported structural operation");
}
