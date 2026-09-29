/**
 * Transparent application-layer encryption for Context-managed buckets.
 *
 * The decorator sits immediately above the physical provider adapter and
 * below logical deletion.  Every user body gets a fresh object key; that key
 * is wrapped by the workspace data key the control plane already manages.
 * Paths, provider etags and content-free logical tombstones remain provider
 * metadata so listing and conditional writes retain their existing semantics.
 */

import {
  IV_BYTE_LENGTH,
  KEY_BYTE_LENGTH,
  NoteCryptoError,
  fromBase64Url,
  importAesKey,
  keyBytesFrom,
  requireKeyId,
  requireWorkspaceId,
  toBase64Url,
} from "../encryption/primitives.js";
import {
  ATTACHMENT_CONTENT_TYPE,
  LOGICAL_DELETE_CONTENT_TYPE,
  MARKDOWN_CONTENT_TYPE,
  assertWritableContentType,
} from "./index.js";
import { isLogicalDeleteMarker } from "./logicalDelete.js";

export const MANAGED_ENVELOPE_MAGIC = "CTXSTORE1";
const VERSION = 1;
const ALG = "A256GCM";
const PHYSICAL_CONTENT_TYPE = ATTACHMENT_CONTENT_TYPE;
const MAX_HEADER_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const magic = encoder.encode(MANAGED_ENVELOPE_MAGIC);

export class ManagedStorageCryptoError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManagedStorageCryptoError";
  }
}

function fail(message) {
  throw new ManagedStorageCryptoError(message);
}

function bytesOf(value) {
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new ManagedStorageCryptoError("managed storage received an unsupported body");
}

function exactBuffer(value) {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

function contentAad(workspaceId) {
  return encoder.encode(`context-managed-object-v1:${workspaceId}`);
}

function wrapAad(workspaceId) {
  return encoder.encode(`context-managed-object-key-v1:${workspaceId}`);
}

function startsWithMagic(body) {
  if (body.byteLength < magic.byteLength) return false;
  for (let index = 0; index < magic.byteLength; index += 1) {
    if (body[index] !== magic[index]) return false;
  }
  return true;
}

function encodeEnvelope(header, ciphertext) {
  const headerBytes = encoder.encode(JSON.stringify(header));
  if (headerBytes.byteLength > MAX_HEADER_BYTES) fail("managed envelope header is too large");
  const output = new Uint8Array(magic.byteLength + 4 + headerBytes.byteLength + ciphertext.byteLength);
  output.set(magic, 0);
  new DataView(output.buffer).setUint32(magic.byteLength, headerBytes.byteLength, false);
  output.set(headerBytes, magic.byteLength + 4);
  output.set(ciphertext, magic.byteLength + 4 + headerBytes.byteLength);
  return output;
}

function parseEnvelope(body) {
  if (!startsWithMagic(body)) return null;
  if (body.byteLength < magic.byteLength + 4) fail("managed envelope is truncated");
  const headerLength = new DataView(
    body.buffer,
    body.byteOffset + magic.byteLength,
    4,
  ).getUint32(0, false);
  if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES) {
    fail("managed envelope header has an invalid length");
  }
  const bodyStart = magic.byteLength + 4 + headerLength;
  if (bodyStart >= body.byteLength) fail("managed envelope is truncated");
  let header;
  try {
    header = JSON.parse(strictDecoder.decode(body.slice(magic.byteLength + 4, bodyStart)));
  } catch {
    fail("managed envelope header is malformed");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    fail("managed envelope header is malformed");
  }
  if (header.v !== VERSION || header.alg !== ALG) fail("managed envelope version is unsupported");
  if (typeof header.keyId !== "string" || typeof header.contentType !== "string") {
    fail("managed envelope header is incomplete");
  }
  try {
    requireKeyId(header.keyId);
    assertWritableContentType(header.contentType);
  } catch {
    fail("managed envelope header is invalid");
  }
  if (!Number.isSafeInteger(header.plaintextBytes) || header.plaintextBytes < 0) {
    fail("managed envelope length is invalid");
  }
  for (const field of ["contentIv", "wrapIv", "wrappedKey"]) {
    if (typeof header[field] !== "string") fail("managed envelope header is incomplete");
  }
  return { header, ciphertext: body.slice(bodyStart) };
}

export function isManagedEncryptedBytes(value) {
  return startsWithMagic(bytesOf(value));
}

function requireContext({ workspaceId, encryptionKey } = {}) {
  try {
    requireWorkspaceId(workspaceId);
  } catch {
    fail("managed storage requires a workspace id");
  }
  if (!encryptionKey || typeof encryptionKey !== "object") {
    fail("managed storage requires a workspace data key");
  }
  const { current, keys } = encryptionKey;
  try {
    requireKeyId(current);
  } catch {
    fail("managed storage requires a valid current key generation");
  }
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    fail("managed storage requires workspace data keys");
  }
  try {
    keyBytesFrom(keys[current]);
  } catch {
    fail("managed storage requires valid current key material");
  }
  return { workspaceId, current, keys };
}

async function encryptBody(plaintext, contentType, context) {
  const objectKeyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTE_LENGTH));
  const objectKey = await importAesKey(objectKeyBytes);
  const contentIv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: contentIv, additionalData: contentAad(context.workspaceId) },
      objectKey,
      plaintext,
    ),
  );

  let workspaceKey;
  try {
    workspaceKey = await importAesKey(keyBytesFrom(context.keys[context.current]));
  } catch {
    fail("managed storage current key is unavailable");
  }
  const wrapIv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const wrappedKey = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: wrapIv, additionalData: wrapAad(context.workspaceId) },
      workspaceKey,
      objectKeyBytes,
    ),
  );
  return encodeEnvelope(
    {
      v: VERSION,
      alg: ALG,
      keyId: context.current,
      contentIv: toBase64Url(contentIv),
      wrapIv: toBase64Url(wrapIv),
      wrappedKey: toBase64Url(wrappedKey),
      contentType,
      plaintextBytes: plaintext.byteLength,
    },
    ciphertext,
  );
}

async function decryptBody(parsed, context) {
  const material = context.keys[parsed.header.keyId];
  if (typeof material !== "string" || !material) fail("managed storage key generation is unavailable");
  try {
    const workspaceKey = await importAesKey(keyBytesFrom(material));
    const objectKeyBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64Url(parsed.header.wrapIv),
          additionalData: wrapAad(context.workspaceId),
        },
        workspaceKey,
        fromBase64Url(parsed.header.wrappedKey),
      ),
    );
    if (objectKeyBytes.byteLength !== KEY_BYTE_LENGTH) fail("managed object key has an invalid length");
    const objectKey = await importAesKey(objectKeyBytes);
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64Url(parsed.header.contentIv),
          additionalData: contentAad(context.workspaceId),
        },
        objectKey,
        parsed.ciphertext,
      ),
    );
    if (plaintext.byteLength !== parsed.header.plaintextBytes) fail("managed plaintext length does not match");
    return plaintext;
  } catch (error) {
    if (error instanceof ManagedStorageCryptoError) throw error;
    if (error instanceof NoteCryptoError) fail("managed envelope contains invalid key material");
    fail("managed object authentication failed");
  }
}

async function readPhysical(object) {
  const value = object.arrayBuffer
    ? new Uint8Array(await object.arrayBuffer())
    : encoder.encode(await object.text());
  return value.slice();
}

function logicalObject(object, plaintext, contentType) {
  return {
    ...object,
    size: plaintext.byteLength,
    contentType,
    text: async () => decoder.decode(plaintext),
    arrayBuffer: async () => exactBuffer(plaintext.slice()),
  };
}

/**
 * @param {import("./index.js").ContextStore} store physical provider store
 * @param {{workspaceId: string, encryptionKey: {current: string, keys: Record<string,string>}, allowPlaintextRead?: boolean}} encryptionContext
 */
export function withManagedEncryption(store, encryptionContext) {
  if (!store) return store;
  const context = requireContext(encryptionContext);
  const allowPlaintextRead = encryptionContext?.allowPlaintextRead === true;
  const capabilities = {
    ...store.capabilities,
    // Provider copy would duplicate an envelope without minting a fresh object
    // key and bypasses the decorator entirely. The logical layer falls back to
    // authenticated get + fresh encrypted put.
    serverSideCopy: false,
  };
  return {
    managedEncryption: true,
    capabilities,
    async get(key) {
      const object = await store.get(key);
      if (object === null) return null;
      const physical = await readPhysical(object);
      const contentType = object.contentType || object.httpMetadata?.contentType;
      if (contentType === LOGICAL_DELETE_CONTENT_TYPE || isLogicalDeleteMarker(physical)) {
        return logicalObject(object, physical, LOGICAL_DELETE_CONTENT_TYPE);
      }
      const parsed = parseEnvelope(physical);
      if (parsed === null) {
        if (allowPlaintextRead) return logicalObject(object, physical, contentType || MARKDOWN_CONTENT_TYPE);
        fail("managed bucket contains an unencrypted object");
      }
      return logicalObject(object, await decryptBody(parsed, context), parsed.header.contentType);
    },
    async put(key, value, options = {}) {
      const contentType = assertWritableContentType(options.contentType);
      if (contentType === LOGICAL_DELETE_CONTENT_TYPE) {
        return await store.put(key, value, options);
      }
      const encrypted = await encryptBody(bytesOf(value), contentType, context);
      return await store.put(key, encrypted, {
        ...options,
        contentType: PHYSICAL_CONTENT_TYPE,
      });
    },
    async delete(key, options) {
      return await store.delete(key, options);
    },
    async list(options) {
      return await store.list(options);
    },
  };
}

/**
 * Convert one pre-rollout physical object in place, guarded by its etag.
 * Already-encrypted bodies and content-free tombstones are idempotent skips.
 * A concurrent gateway write wins; the next pass will observe its encrypted
 * replacement instead of overwriting it with stale plaintext.
 */
export async function encryptManagedObject(store, key, encryptionContext) {
  const context = requireContext(encryptionContext);
  const object = await store.get(key);
  if (object === null) return { status: "missing" };
  const physical = await readPhysical(object);
  const contentType = object.contentType || object.httpMetadata?.contentType;
  if (
    startsWithMagic(physical) ||
    contentType === LOGICAL_DELETE_CONTENT_TYPE ||
    isLogicalDeleteMarker(physical)
  ) {
    return { status: "already-protected" };
  }
  if (typeof object.etag !== "string" || object.etag.length === 0) {
    fail("managed encryption migration requires an object etag");
  }
  const logicalContentType = assertWritableContentType(contentType || MARKDOWN_CONTENT_TYPE);
  const encrypted = await encryptBody(physical, logicalContentType, context);
  const written = await store.put(key, encrypted, {
    contentType: PHYSICAL_CONTENT_TYPE,
    onlyIf: { etagMatches: object.etag },
  });
  return written === null
    ? { status: "conflict" }
    : { status: "encrypted", etag: written.etag };
}
