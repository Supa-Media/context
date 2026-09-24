/**
 * Where collaboration state lives in the customer's bucket and how it is read
 * and written: the key layout under `.context/collaboration/v1`, the error
 * callers classify, base64, and the two conditional storage primitives.
 */

export const SCHEMA_VERSION = 1;
export const ROOT = ".context/collaboration/v1";
export const HEAD_PREFIX = `${ROOT}/heads/`;
const DOCUMENT_PREFIX = `${ROOT}/documents/`;
export const REVISION_PREFIX = `${ROOT}/revisions/`;
const OPERATION_PREFIX = `${ROOT}/documents/`;
export const STRUCTURAL_PREFIX = `${ROOT}/structural/`;
export const MAX_RETRIES = 24;
export const MAX_NOTE_BYTES = 4 * 1024 * 1024;
export const MAX_UPDATE_BYTES = 8 * 1024 * 1024;

/** An error that is safe for callers to classify without exposing bucket data. */
export class CollaborationError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CollaborationError";
    this.code = code;
  }
}

export function fail(code, message, cause) {
  return new CollaborationError(code, message, cause);
}

export function isObject(value) {
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

export function requireSupported(store) {
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

export async function operationKey(documentId, expectedEtag, text) {
  return `${OPERATION_PREFIX}${documentId}/operations/${await pathHash(`${expectedEtag}\0${text}`)}.json`;
}

export function structuralKey(operationId) {
  return `${STRUCTURAL_PREFIX}${operationId}.json`;
}

export async function headKey(path) {
  return `${HEAD_PREFIX}${await pathHash(path)}.json`;
}

export function documentKey(documentId) {
  return `${DOCUMENT_PREFIX}${documentId}.json`;
}

export function revisionKey(documentId, revision) {
  return `${REVISION_PREFIX}${documentId}/${revision}.json`;
}

export function revisionEtag(documentId, revision) {
  return `c2.${documentId}.${revision}`;
}

export function randomId(prefix) {
  if (typeof globalThis.crypto?.randomUUID === "function") return `${prefix}-${globalThis.crypto.randomUUID()}`;
  const random = Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function bytesToBase64(bytes) {
  let binary = "";
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let index = 0; index < value.length; index += 1) binary += String.fromCharCode(value[index]);
  if (typeof globalThis.btoa === "function") return globalThis.btoa(binary);
  if (typeof Buffer !== "undefined") return Buffer.from(value).toString("base64");
  throw new Error("base64 encoding is unavailable");
}

export function base64ToBytes(value) {
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

export function parseJson(text, what) {
  try {
    const value = JSON.parse(text);
    if (!isObject(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    throw fail("CORRUPT_STATE", `collaboration ${what} is invalid`, error);
  }
}

export async function readObject(store, key) {
  const object = await store.get(key);
  if (!object) return null;
  if (typeof object.text !== "function" || typeof object.etag !== "string") {
    throw fail("CORRUPT_STATE", "storage returned an invalid object");
  }
  return { etag: object.etag, text: await object.text() };
}

export async function put(store, key, value, onlyIf) {
  try {
    const result = await store.put(key, value, { onlyIf });
    return result;
  } catch (error) {
    throw fail("STORAGE_WRITE_FAILED", "collaboration storage write failed", error);
  }
}
