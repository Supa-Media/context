import * as Y from "yjs";
import { diffChars as provenDiffChars } from "diff";

const SCHEMA_VERSION = 1;
const ROOT = ".context/collaboration/v1";
const HEAD_PREFIX = `${ROOT}/heads/`;
const DOCUMENT_PREFIX = `${ROOT}/documents/`;
const REVISION_PREFIX = `${ROOT}/revisions/`;
const OPERATION_PREFIX = `${ROOT}/documents/`;
const STRUCTURAL_PREFIX = `${ROOT}/structural/`;
const MAX_RETRIES = 24;
const MAX_NOTE_BYTES = 4 * 1024 * 1024;
const MAX_UPDATE_BYTES = 8 * 1024 * 1024;

/** An error that is safe for callers to classify without exposing bucket data. */
export class CollaborationError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CollaborationError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  return new CollaborationError(code, message, cause);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Return whether a store has both conditional operations this engine needs. */
export function supported(store) {
  return Boolean(
    store &&
      typeof store.get === "function" &&
      typeof store.put === "function" &&
      store.capabilities?.conditionalWrite === true &&
      store.capabilities?.conditionalCreate === true,
  );
}

function requireSupported(store) {
  if (!supported(store)) {
    throw fail(
      "UNSUPPORTED_STORAGE",
      "collaboration requires storage with verified conditionalWrite and conditionalCreate",
    );
  }
}

async function pathHash(path) {
  const bytes = new TextEncoder().encode(path);
  if (!globalThis.crypto?.subtle) throw fail("UNSUPPORTED_STORAGE", "Web Crypto is required for collaboration paths");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function operationKey(documentId, expectedEtag, text) {
  return `${OPERATION_PREFIX}${documentId}/operations/${await pathHash(`${expectedEtag}\0${text}`)}.json`;
}

function structuralKey(operationId) {
  return `${STRUCTURAL_PREFIX}${operationId}.json`;
}

async function headKey(path) {
  return `${HEAD_PREFIX}${await pathHash(path)}.json`;
}

function documentKey(documentId) {
  return `${DOCUMENT_PREFIX}${documentId}.json`;
}

function revisionKey(documentId, revision) {
  return `${REVISION_PREFIX}${documentId}/${revision}.json`;
}

function revisionEtag(documentId, revision) {
  return `c2.${documentId}.${revision}`;
}

function randomId(prefix) {
  if (typeof globalThis.crypto?.randomUUID === "function") return `${prefix}-${globalThis.crypto.randomUUID()}`;
  const random = Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function bytesToBase64(bytes) {
  let binary = "";
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let index = 0; index < value.length; index += 1) binary += String.fromCharCode(value[index]);
  if (typeof globalThis.btoa === "function") return globalThis.btoa(binary);
  if (typeof Buffer !== "undefined") return Buffer.from(value).toString("base64");
  throw new Error("base64 encoding is unavailable");
}

function base64ToBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw fail("INVALID_UPDATE", "update is not valid base64");
  }
  try {
    if (typeof globalThis.atob === "function") {
      const binary = globalThis.atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    }
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  } catch (error) {
    throw fail("INVALID_UPDATE", "update is not valid base64", error);
  }
  throw fail("INVALID_UPDATE", "base64 decoding is unavailable");
}

function parseJson(text, what) {
  try {
    const value = JSON.parse(text);
    if (!isObject(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    throw fail("CORRUPT_STATE", `collaboration ${what} is invalid`, error);
  }
}

async function readObject(store, key) {
  const object = await store.get(key);
  if (!object) return null;
  if (typeof object.text !== "function" || typeof object.etag !== "string") {
    throw fail("CORRUPT_STATE", "storage returned an invalid object");
  }
  return { etag: object.etag, text: await object.text() };
}

async function put(store, key, value, onlyIf) {
  try {
    const result = await store.put(key, value, { onlyIf });
    return result;
  } catch (error) {
    throw fail("STORAGE_WRITE_FAILED", "collaboration storage write failed", error);
  }
}

function newDoc() {
  return new Y.Doc({ gc: false });
}

function assertPlainTextDocument(doc) {
  if ([...doc.share.keys()].some((key) => key !== "note")) {
    throw fail("INVALID_UPDATE", "collaboration documents only contain the note text");
  }
  // Yjs does not encode an untouched empty root type. Accept that one
  // canonical empty state, while still rejecting a hostile different root
  // type named `note`.
  if (!doc.share.has("note") && doc.share.size !== 0) throw fail("INVALID_UPDATE", "collaboration document is missing the note text");
  const note = doc.getText("note");
  if (!(note instanceof Y.Text) || note._map.size !== 0) {
    throw fail("INVALID_UPDATE", "collaboration note must be an unformatted Y.Text");
  }
  for (const part of note.toDelta()) {
    if (typeof part.insert !== "string" || part.attributes && Object.keys(part.attributes).length > 0) {
      throw fail("INVALID_UPDATE", "collaboration note contains a non-plaintext Yjs item");
    }
  }
}

function docFromSnapshot(snapshot) {
  const doc = newDoc();
  try {
    Y.applyUpdate(doc, base64ToBytes(snapshot));
  } catch (error) {
    throw fail("CORRUPT_STATE", "collaboration document snapshot is invalid", error);
  }
  assertPlainTextDocument(doc);
  return doc;
}

function snapshotOf(doc) {
  return bytesToBase64(Y.encodeStateAsUpdate(doc));
}

function stateObject({ documentId, generation, path, text, rawMarkdownEtag, revision = "r0", pending = null, legacyRawEtag, legacyRevision = "r0", deferredUpdates = [], structural = null }) {
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

function validateState(state, head, path) {
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

async function readHead(store, path) {
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

function identityHead(head, status = head.status, extra = {}) {
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

async function scrubHeadSeed(store, head) {
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

async function readState(store, head) {
  const object = await readObject(store, head.stateKey);
  if (!object) return null;
  return { value: parseJson(object.text, "document state"), etag: object.etag };
}

async function readStructural(store, operationId) {
  const object = await readObject(store, structuralKey(operationId));
  if (!object) throw fail("CORRUPT_STATE", "structural collaboration operation is missing");
  const value = parseJson(object.text, "structural operation");
  if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== "move" && value.kind !== "delete" && value.kind !== "restore" && value.kind !== "seal" || value.operationId !== operationId) {
    throw fail("CORRUPT_STATE", "structural collaboration operation is invalid");
  }
  return { value, etag: object.etag };
}

async function writeStructural(store, operation) {
  const written = await put(store, structuralKey(operation.operationId), JSON.stringify(operation), { absent: true });
  if (written) return { value: operation, etag: written.etag };
  const existing = await readStructural(store, operation.operationId);
  if (JSON.stringify(existing.value) !== JSON.stringify(operation)) throw fail("STRUCTURAL_CONFLICT", "structural operation identity was reused");
  return existing;
}

async function updateStructural(store, operation, etag) {
  const written = await put(store, structuralKey(operation.operationId), JSON.stringify(operation), { etagMatches: etag });
  if (written) return { value: operation, etag: written.etag };
  return readStructural(store, operation.operationId);
}

function requireConditionalDelete(store) {
  if (typeof store.delete !== "function" || store.capabilities?.conditionalDelete !== true) {
    throw fail("UNSUPPORTED_STORAGE", "structural collaboration operations require verified conditionalDelete");
  }
}

function assertExpectedRevision(state, expectedEtag) {
  if (expectedEtag === undefined) return;
  if (expectedEtag !== revisionEtag(state.documentId, state.revision) && !(state.revision === state.legacyRevision && expectedEtag === state.legacyRawEtag)) {
    throw fail("CONFLICT", "document revision no longer matches");
  }
}

async function readRevision(store, documentId, revision) {
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

async function writeRevision(store, revision) {
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

function assertEligible(path, text) {
  if (!eligible(trashOriginalPath(path) ?? path, text)) throw fail("INELIGIBLE_DOCUMENT", "document is not eligible for collaboration");
}

/** The encrypted Markdown wrapper is opaque to collaboration forever. */
function isEncryptedEnvelope(text) {
  if (typeof text !== "string") return false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  if (!frontmatter || !/^\s*context_encryption\s*:\s*v\d+\s*$/m.test(frontmatter[1])) return false;
  return /```context-encrypted\s*\r?\n[\s\S]*\r?\n```(?:\r?\n|$)/.test(body);
}

// Only lifecycle operations admit the existing private trash layout. Public
// read/write entry points still refuse every plumbing path.
function trashOriginalPath(path) {
  return typeof path === "string"
    ? /^\.context\/trash\/[A-Za-z0-9][A-Za-z0-9._-]*\/(.+)$/.exec(path)?.[1] ?? null
    : null;
}

function lifecyclePath(path, internalTrash) {
  return eligible(path, "") || (internalTrash === true && eligible(trashOriginalPath(path), ""));
}

/** Whether a path and its stored text are supported by the plaintext editor. */
export function eligible(path, text = "") {
  if (typeof path !== "string" || typeof text !== "string" || path.length === 0 || path.startsWith("/") || !path.endsWith(".md")) return false;
  const parts = path.split("/");
  const basename = parts.at(-1) || "";
  if (parts.some((part) => part === "" || part.startsWith("."))) return false;
  if (basename === "privacy.md") return false;
  if (/\.(?:excalidraw(?:\.md)?|excalidraw\.json)$/i.test(basename)) return false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const frontmatterEnd = body.startsWith("---") ? body.indexOf("\n---", 3) : -1;
  if (frontmatterEnd >= 0 && /^\s*context_encryption\s*:\s*v?\d+\s*$/m.test(body.slice(3, frontmatterEnd))) return false;
  return true;
}

function assertTextSize(text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > MAX_NOTE_BYTES) {
    throw fail("NOTE_TOO_LARGE", "collaboration note exceeds the supported size");
  }
}

function assertUpdateBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw fail("INVALID_UPDATE", "update must contain Yjs bytes");
}

function applyUpdateTo(doc, bytes) {
  assertUpdateBytes(bytes);
  if (bytes.byteLength > MAX_UPDATE_BYTES) throw fail("UPDATE_TOO_LARGE", "collaboration update exceeds the supported size");
  const before = Y.encodeStateVector(doc);
  try {
    Y.applyUpdate(doc, bytes);
  } catch (error) {
    throw fail("INVALID_UPDATE", "update is not a valid Yjs update", error);
  }
  assertPlainTextDocument(doc);
  return Y.encodeStateAsUpdate(doc, before);
}

function hasPendingDependencies(doc) {
  const pending = doc.store?.pendingStructs;
  return Boolean(pending?.missing && pending.missing.size > 0);
}

function makeResult(state, revision) {
  const value = revision?.value ?? revision;
  return {
    documentId: state.documentId,
    update: value.snapshot,
    text: value.text,
    etag: revisionEtag(state.documentId, state.revision),
  };
}

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

async function putHead(store, path, head, expectedEtag) {
  return put(store, await headKey(path), JSON.stringify(head), { etagMatches: expectedEtag });
}

async function recoverMove(store, operationId) {
  const opRecord = await readStructural(store, operationId);
  const op = opRecord.value;
  const sourceHead = await readHead(store, op.from);
  const destinationHead = await readHead(store, op.to);
  const sourceStateRecord = await readState(store, {
    stateKey: op.stateKey,
    documentId: op.documentId,
    generation: op.generation,
  });
  if (!sourceStateRecord) throw fail("CORRUPT_STATE", "moved document state is missing");
  let state = validateState(sourceStateRecord.value, { documentId: op.documentId, generation: op.generation }, sourceStateRecord.value.path);

  if (sourceHead?.status === "active") {
    const moving = await putHead(store, op.from, identityHead(sourceHead, "moving", { operationId, destination: op.to }), sourceHead.etag);
    if (!moving) return recoverMove(store, operationId);
  } else if (sourceHead && sourceHead.status !== "moving" && sourceHead.status !== "moved") {
    throw fail("STRUCTURAL_CONFLICT", "source path changed during the move");
  }

  const returning = destinationHead?.status === "moved" && destinationHead.documentId === op.documentId && destinationHead.destination === op.from;
  if (!destinationHead || returning) {
    const prepared = {
      schemaVersion: SCHEMA_VERSION,
      path: op.to,
      documentId: op.documentId,
      generation: op.generation,
      stateKey: op.stateKey,
      status: "prepared",
      operationId,
      source: op.from,
    };
    const created = await put(store, await headKey(op.to), JSON.stringify(prepared), returning ? { etagMatches: destinationHead.etag } : { absent: true });
    if (!created) return recoverMove(store, operationId);
  } else if (destinationHead.documentId !== op.documentId || destinationHead.status !== "prepared" && destinationHead.status !== "active") {
    return abortMove(store, opRecord, "destination path is already owned by another document");
  }

  const sourceObject = await readObject(store, op.from);
  let destinationObject = await readObject(store, op.to);
  if (!destinationObject) {
    if (!sourceObject) {
      if (state.path !== op.to) throw fail("STRUCTURAL_CONFLICT", "source Markdown disappeared before the move completed");
    } else {
      if (sourceObject.etag !== op.sourceRawEtag || sourceObject.text !== op.sourceText) {
        return abortMove(store, opRecord, "source Markdown changed during the move");
      }
      const copied = await put(store, op.to, op.sourceText, { absent: true });
      if (!copied) return recoverMove(store, operationId);
      destinationObject = await readObject(store, op.to);
    }
  } else if (destinationObject.text !== op.sourceText) {
    return abortMove(store, opRecord, "destination path changed during the move");
  }

  const latestSource = await readObject(store, op.from);
  if (latestSource) {
    if (latestSource.etag !== op.sourceRawEtag || latestSource.text !== op.sourceText) {
      return abortMove(store, opRecord, "source Markdown changed during the move");
    }
    const removed = await store.delete(op.from, { onlyIf: { etagMatches: op.sourceRawEtag } });
    if (removed === null) return recoverMove(store, operationId);
    if (await readObject(store, op.from)) return recoverMove(store, operationId);
  }
  if (!destinationObject) destinationObject = await readObject(store, op.to);
  if (!destinationObject) return abortMove(store, opRecord, "move destination was not materialized");

  if (state.path === op.from && state.structural?.operationId === operationId) {
    const nextState = { ...state, path: op.to, rawMarkdownEtag: destinationObject.etag, structural: null };
    const written = await put(store, op.stateKey, JSON.stringify(nextState), { etagMatches: sourceStateRecord.etag });
    if (!written) return recoverMove(store, operationId);
    state = nextState;
  } else if (state.path !== op.to || state.structural !== null) {
    throw fail("STRUCTURAL_CONFLICT", "document state changed during the move");
  }

  const activeDestination = identityHead({
    path: op.to,
    documentId: op.documentId,
    generation: op.generation,
    stateKey: op.stateKey,
  }, "active");
  const currentDestination = await readHead(store, op.to);
  if (currentDestination?.status === "prepared") {
    const activated = await putHead(store, op.to, activeDestination, currentDestination.etag);
    if (!activated) return recoverMove(store, operationId);
  }
  const currentSource = await readHead(store, op.from);
  if (currentSource?.status === "moving") {
    const moved = await putHead(store, op.from, identityHead(currentSource, "moved", { destination: op.to, operationId }), currentSource.etag);
    if (!moved) return recoverMove(store, operationId);
  }
  await updateStructural(store, { ...op, phase: "complete" }, opRecord.etag);
  await scrubStructural(store, operationId);
  return state;
}

/** Roll back a move that was frozen but could not claim its destination. */
async function abortMove(store, opRecord, reason) {
  const op = opRecord.value;
  const stateRecord = await readState(store, { stateKey: op.stateKey, documentId: op.documentId, generation: op.generation });
  if (stateRecord?.value?.structural?.operationId === op.operationId) {
    const cleared = { ...stateRecord.value, structural: null };
    const written = await put(store, op.stateKey, JSON.stringify(cleared), { etagMatches: stateRecord.etag });
    if (!written) {
      const latest = await readState(store, { stateKey: op.stateKey, documentId: op.documentId, generation: op.generation });
      if (latest?.value?.structural?.operationId === op.operationId) return abortMove(store, opRecord, reason);
    }
  }
  const sourceHead = await readHead(store, op.from);
  if (sourceHead?.status === "moving" && sourceHead.operationId === op.operationId) {
    const active = identityHead(sourceHead, "active");
    const restored = await putHead(store, op.from, active, sourceHead.etag);
    if (!restored) return abortMove(store, opRecord, reason);
  }
  await updateStructural(store, { ...op, phase: "aborted", abortedReason: reason }, opRecord.etag);
  return { aborted: true, reason };
}

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

async function scrubStructural(store, operationId) {
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
async function recoverSeal(store, operationId) {
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

async function recoverStructural(store, operationId) {
  if (typeof operationId !== "string" || !operationId) throw fail("CORRUPT_STATE", "structural operation id is missing");
  const op = (await readStructural(store, operationId)).value;
  if (op.phase === "aborted") return { aborted: true, reason: op.abortedReason };
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

async function finalizePending(store, path, loaded) {
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

async function ready(store, path) {
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

async function commitSnapshot(store, path, loaded, documentId, nextDoc) {
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

function diffChars(before, after) {
  const operations = [];
  let baseIndex = 0;
  for (const part of provenDiffChars(before, after)) {
    if (part.added) {
      const previous = operations.at(-1);
      if (previous && previous.index + previous.deleteCount === baseIndex && previous.deleteCount > 0) previous.insert += part.value;
      else operations.push({ index: baseIndex, deleteCount: 0, insert: part.value });
    } else if (part.removed) {
      operations.push({ index: baseIndex, deleteCount: part.value.length, insert: "" });
      baseIndex += part.value.length;
    } else baseIndex += part.value.length;
  }
  return operations;
}

function replacementUpdate(baseSnapshot, targetText) {
  const base = docFromSnapshot(baseSnapshot);
  const text = base.getText("note");
  const before = text.toString();
  const beforeVector = Y.encodeStateVector(base);
  const operations = diffChars(before, targetText);
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index];
    if (operation.deleteCount) text.delete(operation.index, operation.deleteCount);
    if (operation.insert) text.insert(operation.index, operation.insert);
  }
  return { base, update: Y.encodeStateAsUpdate(base, beforeVector) };
}

async function cachedReplacementUpdate(store, documentId, generation, expectedEtag, text, baseSnapshot) {
  const key = await operationKey(documentId, expectedEtag, text);
  const existing = await readObject(store, key);
  if (existing) {
    const value = parseJson(existing.text, "replacement operation");
    if (
      value.schemaVersion !== SCHEMA_VERSION ||
      value.kind !== "replacement" ||
      value.documentId !== documentId ||
      value.generation !== generation ||
      value.expectedEtag !== expectedEtag ||
      value.text !== text ||
      typeof value.update !== "string"
    ) throw fail("CORRUPT_STATE", "replacement operation identity was reused");
    return base64ToBytes(value.update);
  }
  const generated = replacementUpdate(baseSnapshot, text).update;
  const value = {
    schemaVersion: SCHEMA_VERSION,
    kind: "replacement",
    documentId,
    generation,
    expectedEtag,
    text,
    update: bytesToBase64(generated),
  };
  const written = await put(store, key, JSON.stringify(value), { absent: true });
  if (written) return generated;
  const raced = await readObject(store, key);
  if (!raced) throw fail("STORAGE_WRITE_FAILED", "replacement operation could not be retained");
  const racedValue = parseJson(raced.text, "replacement operation");
  if (
    racedValue.schemaVersion !== SCHEMA_VERSION ||
    racedValue.kind !== "replacement" ||
    racedValue.documentId !== documentId ||
    racedValue.generation !== generation ||
    racedValue.expectedEtag !== expectedEtag ||
    racedValue.text !== text ||
    typeof racedValue.update !== "string"
  ) throw fail("CORRUPT_STATE", "replacement operation identity was reused");
  return base64ToBytes(racedValue.update);
}

/** Replace an agent's exact retained base while preserving unseen Yjs items. */
export async function replaceText(store, path, input) {
  requireSupported(store);
  if (!eligible(path, "")) throw fail("INELIGIBLE_DOCUMENT", "document is not eligible for collaboration");
  if (!isObject(input) || typeof input.expectedEtag !== "string" || typeof input.text !== "string" || (input.documentId !== undefined && typeof input.documentId !== "string")) {
    throw fail("INVALID_ARGUMENT", "expectedEtag and text are required");
  }
  let loaded = await ready(store, path);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    if (input.documentId !== undefined && loaded.state.documentId !== input.documentId) throw fail("GENERATION_MISMATCH", "document generation does not match");
    if (loaded.state.deferredUpdates.length > 0) throw fail("DEPENDENCY_PENDING", "replacement waits for missing Yjs dependencies");
    let baseRevision;
    const tokenMatch = /^c2\.([A-Za-z0-9-]+)\.([A-Za-z0-9-]+)$/.exec(input.expectedEtag);
    if (tokenMatch) {
      if (tokenMatch[1] !== loaded.state.documentId) throw fail("GENERATION_MISMATCH", "the requested base belongs to another generation");
      const suffix = tokenMatch[2];
      if (!/^[A-Za-z0-9-]+$/.test(suffix)) throw fail("BASE_MISSING", "the requested Markdown base is invalid");
      baseRevision = await readRevision(store, loaded.state.documentId, suffix);
    } else if (input.expectedEtag === loaded.state.legacyRawEtag) {
      baseRevision = await readRevision(store, loaded.state.documentId, loaded.state.legacyRevision);
    } else {
      throw fail("BASE_MISSING", "the requested Markdown base is no longer retained");
    }
    if (baseRevision.value.generation !== loaded.state.generation) throw fail("GENERATION_MISMATCH", "the requested base belongs to another generation");
    assertTextSize(input.text);
    const update = await cachedReplacementUpdate(
      store,
      loaded.state.documentId,
      loaded.state.generation,
      input.expectedEtag,
      input.text,
      baseRevision.value.snapshot,
    );
    const current = docFromSnapshot(loaded.revision.value.snapshot);
    applyUpdateTo(current, update);
    const result = await commitSnapshot(store, path, loaded, loaded.state.documentId, current);
    if (result) return result;
    loaded = await ready(store, path);
  }
  throw fail("CONCURRENT_WRITE", "collaboration state kept changing during replacement");
}

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

async function purgeDocumentState(store, op) {
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
