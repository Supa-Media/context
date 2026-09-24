/** Replacing text against an exact retained base, preserving unseen Yjs items. */

import * as Y from "yjs";
import { diffChars as provenDiffChars } from "diff";
import { eligible } from "./eligibility.js";
import {
  MAX_RETRIES,
  SCHEMA_VERSION,
  base64ToBytes,
  bytesToBase64,
  fail,
  isObject,
  operationKey,
  parseJson,
  put,
  readObject,
  requireSupported,
} from "./storage.js";
import { applyUpdateTo, assertTextSize, docFromSnapshot } from "./ydoc.js";
import { readRevision } from "./records.js";
import { ready } from "./load.js";
import { commitSnapshot } from "./commit.js";

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
