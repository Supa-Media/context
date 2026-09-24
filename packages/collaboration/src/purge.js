/** Removing a generation's retained history once a journal says it may go. */

import {
  HEAD_PREFIX,
  REVISION_PREFIX,
  ROOT,
  SCHEMA_VERSION,
  STRUCTURAL_PREFIX,
  documentKey,
  fail,
  parseJson,
  put,
  readObject,
  structuralKey,
} from "./storage.js";
import { readStructural, updateStructural } from "./records.js";

export async function scrubStructural(store, operationId) {
  const record = await readStructural(store, operationId).catch((error) => {
    if (error?.code === "CORRUPT_STATE") return null;
    throw error;
  });
  if (!record || record.value.phase !== "complete") return;
  const clean = { ...record.value };
  delete clean.sourceRawEtag;
  delete clean.sourceText;
  delete clean.initialSnapshot;
  const written = await updateStructural(store, clean, record.etag);
  try {
    await store.delete(structuralKey(operationId), { onlyIf: { etagMatches: written.etag } });
  } catch {
    // The completed journal is already content-free; a later load can retry
    // removing its metadata without affecting the structural outcome.
  }
}

export async function purgeDocumentState(store, op) {
  if (typeof store.list !== "function") throw fail("UNSUPPORTED_STORAGE", "permanent deletion requires list support to purge collaboration history");
  const listAll = async (prefix) => {
    let cursor;
    const found = [];
    for (;;) {
      const result = await store.list({ prefix, cursor, limit: 100 });
      for (const object of result.objects || []) found.push(object);
      if (!result.truncated) return found;
      if (!result.cursor || result.cursor === cursor) throw fail("STORAGE_READ_FAILED", "could not enumerate collaboration history for purge");
      cursor = result.cursor;
    }
  };
  const keys = [];
  const state = await readObject(store, documentKey(op.documentId));
  if (state) keys.push({ key: documentKey(op.documentId), etag: state.etag });
  keys.push(...await listAll(`${ROOT}/documents/${op.documentId}/`));
  keys.push(...await listAll(`${REVISION_PREFIX}${op.documentId}/`));
  const seen = new Set();
  const uniqueKeys = keys.filter((object) => {
    if (seen.has(object.key)) return false;
    seen.add(object.key);
    return true;
  });
  uniqueKeys.sort((left, right) => (left.key === documentKey(op.documentId) ? 1 : right.key === documentKey(op.documentId) ? -1 : 0));
  for (const object of uniqueKeys) {
    if (typeof object.etag !== "string") throw fail("UNSUPPORTED_STORAGE", "permanent deletion requires etags for collaboration purge");
    const removed = await store.delete(object.key, { onlyIf: { etagMatches: object.etag } });
    if (removed === null && await readObject(store, object.key)) throw fail("PURGE_CONFLICT", "collaboration history changed during permanent deletion");
  }

  // Structural records are recovery metadata, but they also retain source text
  // and seed snapshots. Purge every operation for this generation, including
  // an earlier move whose source head is now only an identity fence.
  for (const structuralObject of await listAll(STRUCTURAL_PREFIX)) {
    const current = await readObject(store, structuralObject.key);
    if (!current) continue;
    const structural = parseJson(current.text, "structural operation");
    if (structural.documentId !== op.documentId) continue;
    const removed = await store.delete(structuralObject.key, { onlyIf: { etagMatches: current.etag } });
    if (removed === null && await readObject(store, structuralObject.key)) throw fail("PURGE_CONFLICT", "structural history changed during permanent deletion");
  }

  // A moved source head is still a generation fence, but must not retain the
  // old note's prose or Yjs seed. Keep only identity and routing metadata.
  for (const headObject of await listAll(HEAD_PREFIX)) {
    if (typeof headObject.etag !== "string") throw fail("UNSUPPORTED_STORAGE", "permanent deletion requires etags for collaboration heads");
    const currentHead = await readObject(store, headObject.key);
    if (!currentHead) continue;
    const parsed = parseJson(currentHead.text, "path head");
    if (parsed.documentId !== op.documentId) continue;
    const redacted = {
      schemaVersion: SCHEMA_VERSION,
      path: parsed.path,
      documentId: parsed.documentId,
      generation: parsed.generation,
      stateKey: parsed.stateKey,
      status: parsed.status,
      ...(parsed.destination ? { destination: parsed.destination } : {}),
    };
    const written = await put(store, headObject.key, JSON.stringify(redacted), { etagMatches: currentHead.etag });
    if (!written) throw fail("PURGE_CONFLICT", "collaboration path changed during permanent deletion");
  }
}
