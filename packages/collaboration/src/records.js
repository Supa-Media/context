/**
 * The durable records: document state, path heads, structural journals and
 * retained revisions, each validated on the way in.
 */

import {
  SCHEMA_VERSION,
  documentKey,
  fail,
  headKey,
  isObject,
  parseJson,
  put,
  readObject,
  revisionEtag,
  revisionKey,
  structuralKey,
} from "./storage.js";
import { docFromSnapshot } from "./ydoc.js";

export function stateObject({ documentId, generation, path, text, rawMarkdownEtag, revision = "r0", pending = null, legacyRawEtag, legacyRevision = "r0", deferredUpdates = [], structural = null }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "document",
    path,
    documentId,
    generation,
    text,
    revision,
    rawMarkdownEtag,
    pending,
    legacyRawEtag: legacyRawEtag ?? rawMarkdownEtag,
    legacyRevision,
    deferredUpdates,
    structural,
  };
}

export function validateState(state, head, path) {
  if (
    state.schemaVersion !== SCHEMA_VERSION ||
    state.kind !== "document" ||
    state.path !== path ||
    state.documentId !== head.documentId ||
    state.generation !== head.generation ||
    typeof state.text !== "string" ||
    typeof state.rawMarkdownEtag !== "string" ||
    typeof state.revision !== "string" ||
    !state.revision ||
    typeof state.legacyRawEtag !== "string" ||
    typeof state.legacyRevision !== "string" ||
    !state.legacyRevision ||
    !Array.isArray(state.deferredUpdates) ||
    state.deferredUpdates.some((update) => typeof update !== "string") ||
    (state.pending !== null && (!isObject(state.pending) || typeof state.pending.revision !== "string" || typeof state.pending.previousRevision !== "string" || typeof state.pending.previousRawEtag !== "string" || typeof state.pending.text !== "string")) ||
    (state.structural !== null && (!isObject(state.structural) || typeof state.structural.operationId !== "string" || !["move", "delete", "restore", "seal"].includes(state.structural.kind)))
  ) {
    throw fail("CORRUPT_STATE", "collaboration document identity or state is invalid");
  }
  return state;
}

export async function readHead(store, path) {
  const object = await readObject(store, await headKey(path));
  if (!object) return null;
  const head = parseJson(object.text, "path head");
  if (
    head.schemaVersion !== SCHEMA_VERSION ||
    head.path !== path ||
    typeof head.documentId !== "string" ||
    typeof head.generation !== "string" ||
    typeof head.stateKey !== "string" ||
    head.stateKey !== documentKey(head.documentId) ||
    !["active", "moving", "prepared", "moved", "deleting", "deleted", "restoring", "sealing", "sealed"].includes(head.status || "active")
  ) {
    throw fail("CORRUPT_STATE", "collaboration path head is invalid");
  }
  return { ...head, status: head.status || "active", etag: object.etag };
}

export function identityHead(head, status = head.status, extra = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    path: head.path,
    documentId: head.documentId,
    generation: head.generation,
    stateKey: head.stateKey,
    status,
    ...extra,
  };
}

export async function scrubHeadSeed(store, head) {
  if (typeof head.initialEtag !== "string" && typeof head.initialText !== "string" && typeof head.initialSnapshot !== "string") return head;
  const current = await readHead(store, head.path);
  if (!current || current.documentId !== head.documentId) return current;
  await putHead(store, current.path, identityHead(current, current.status, {
    ...(current.destination ? { destination: current.destination } : {}),
    ...(current.operationId ? { operationId: current.operationId } : {}),
    ...(current.source ? { source: current.source } : {}),
  }), current.etag);
  return readHead(store, current.path);
}

export async function readState(store, head) {
  const object = await readObject(store, head.stateKey);
  if (!object) return null;
  return { value: parseJson(object.text, "document state"), etag: object.etag };
}

export async function readStructural(store, operationId) {
  const object = await readObject(store, structuralKey(operationId));
  if (!object) throw fail("CORRUPT_STATE", "structural collaboration operation is missing");
  const value = parseJson(object.text, "structural operation");
  if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== "move" && value.kind !== "delete" && value.kind !== "restore" && value.kind !== "seal" || value.operationId !== operationId) {
    throw fail("CORRUPT_STATE", "structural collaboration operation is invalid");
  }
  return { value, etag: object.etag };
}

export async function writeStructural(store, operation) {
  const written = await put(store, structuralKey(operation.operationId), JSON.stringify(operation), { absent: true });
  if (written) return { value: operation, etag: written.etag };
  const existing = await readStructural(store, operation.operationId);
  if (JSON.stringify(existing.value) !== JSON.stringify(operation)) throw fail("STRUCTURAL_CONFLICT", "structural operation identity was reused");
  return existing;
}

export async function updateStructural(store, operation, etag) {
  const written = await put(store, structuralKey(operation.operationId), JSON.stringify(operation), { etagMatches: etag });
  if (written) return { value: operation, etag: written.etag };
  return readStructural(store, operation.operationId);
}

export function requireConditionalDelete(store) {
  if (typeof store.delete !== "function" || store.capabilities?.conditionalDelete !== true) {
    throw fail("UNSUPPORTED_STORAGE", "structural collaboration operations require verified conditionalDelete");
  }
}

export function assertExpectedRevision(state, expectedEtag) {
  if (expectedEtag === undefined) return;
  if (expectedEtag !== revisionEtag(state.documentId, state.revision) && !(state.revision === state.legacyRevision && expectedEtag === state.legacyRawEtag)) {
    throw fail("CONFLICT", "document revision no longer matches");
  }
}

export async function readRevision(store, documentId, revision) {
  if (typeof revision !== "string" || !revision || !/^[A-Za-z0-9-]+$/.test(revision)) throw fail("CORRUPT_STATE", "collaboration revision is invalid");
  const object = await readObject(store, revisionKey(documentId, revision));
  if (!object) throw fail("BASE_MISSING", "the retained collaboration revision is missing");
  const value = parseJson(object.text, "document revision");
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    value.kind !== "revision" ||
    value.documentId !== documentId ||
    value.revision !== revision ||
    typeof value.snapshot !== "string" ||
    typeof value.text !== "string" ||
    typeof value.rawMarkdownEtag !== "string"
  ) throw fail("CORRUPT_STATE", "collaboration revision is invalid");
  docFromSnapshot(value.snapshot);
  return { value, etag: object.etag };
}

export async function writeRevision(store, revision) {
  const key = revisionKey(revision.documentId, revision.revision);
  const value = {
    schemaVersion: SCHEMA_VERSION,
    kind: "revision",
    documentId: revision.documentId,
    generation: revision.generation,
    revision: revision.revision,
    snapshot: revision.snapshot,
    text: revision.text,
    rawMarkdownEtag: revision.rawMarkdownEtag,
  };
  const written = await put(store, key, JSON.stringify(value), { absent: true });
  if (written) return { value, etag: written.etag };
  const existing = await readRevision(store, revision.documentId, revision.revision);
  if (
    existing.value.snapshot !== value.snapshot ||
    existing.value.text !== value.text ||
    existing.value.generation !== value.generation
  ) throw fail("CORRUPT_STATE", "collaboration revision identity was reused");
  return existing;
}

export function makeResult(state, revision) {
  const value = revision?.value ?? revision;
  return {
    documentId: state.documentId,
    update: value.snapshot,
    text: value.text,
    etag: revisionEtag(state.documentId, state.revision),
    rawEtag: state.rawMarkdownEtag,
  };
}

export async function putHead(store, path, head, expectedEtag) {
  return put(store, await headKey(path), JSON.stringify(head), { etagMatches: expectedEtag });
}
