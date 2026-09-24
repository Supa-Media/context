/** The Yjs side: plain-text documents, snapshots, and bounded updates. */

import * as Y from "yjs";
import { MAX_NOTE_BYTES, MAX_UPDATE_BYTES, base64ToBytes, bytesToBase64, fail } from "./storage.js";

export function newDoc() {
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

export function docFromSnapshot(snapshot) {
  const doc = newDoc();
  try {
    Y.applyUpdate(doc, base64ToBytes(snapshot));
  } catch (error) {
    throw fail("CORRUPT_STATE", "collaboration document snapshot is invalid", error);
  }
  assertPlainTextDocument(doc);
  return doc;
}

export function snapshotOf(doc) {
  return bytesToBase64(Y.encodeStateAsUpdate(doc));
}

export function assertTextSize(text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > MAX_NOTE_BYTES) {
    throw fail("NOTE_TOO_LARGE", "collaboration note exceeds the supported size");
  }
}

export function assertUpdateBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw fail("INVALID_UPDATE", "update must contain Yjs bytes");
}

export function applyUpdateTo(doc, bytes) {
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

export function hasPendingDependencies(doc) {
  const pending = doc.store?.pendingStructs;
  return Boolean(pending?.missing && pending.missing.size > 0);
}
