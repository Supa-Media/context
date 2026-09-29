/**
 * Encryption of object bodies in a Context-managed bucket.
 *
 * Decision: `docs/decisions/storage-and-credentials/managed-encryption.md`.
 * The short version, because every line below depends on it:
 *
 *  - **Managed buckets only.** A bucket the customer owns is never wrapped;
 *    the control plane sends no `managedEncryption` for one, and this module
 *    has no way to be asked.
 *  - **Application-layer, not end-to-end.** The gateway holds the key while it
 *    serves a request, which is how search and the AI tools keep working.
 *  - **Bodies, not names.** Keys, sizes and listing order stay visible; only
 *    the bytes of each object are sealed.
 *  - **Every exit is plain.** This wrapper decrypts on read, so the hand-off
 *    copy, "Download everything" and the key export all hand back plain files.
 *
 * ## The key
 *
 * The workspace data key (`workspaceDataKeys`, one generation per rotation,
 * never deleted) is the root. The storage key is derived from it with HKDF,
 * under an info string no other use of that key shares, so one secret never
 * does two jobs under the same name (`deriveStorageKey`). Each object then gets its own fresh
 * AES-256 key, wrapped by the storage key of the current generation.
 *
 * ## The object format (version 1)
 *
 *     "CTXENC" 0x01            7 bytes   magic + version
 *     generation length        1 byte
 *     generation               ASCII, KEY_ID_PATTERN
 *     wrap IV                  12 bytes
 *     wrapped object key       48 bytes  (32-byte key + GCM tag)
 *     content IV               12 bytes
 *     ciphertext + GCM tag     rest
 *
 * The content's associated data is the workspace id plus every header byte, so
 * a changed version, generation or wrapped key is a failed tag rather than a
 * different reading. The object's own key (its path) is deliberately **not**
 * bound: a same-store copy is a byte copy, and binding the path would make
 * every server-side copy unreadable at its destination. The workspace id is
 * bound, so bytes lifted from another workspace's bucket never open here.
 *
 * ## Three modes
 *
 * `migrating` accepts plain objects on read (the walk has not reached them
 * yet) and writes encrypted. `encrypted` refuses a plain object on read,
 * except a content-free deletion marker, which the decision leaves visible.
 * `decrypting` is the way back: it accepts both kinds on read and writes
 * plain, while staff walk the bucket back to plain bytes. Deletion markers are
 * written plain in every mode.
 *
 * A read that cannot be decrypted is never answered with the raw bytes. It
 * throws `ManagedEncryptionError` with code `ENCRYPTED_UNREADABLE`, which the
 * app turns into "This note can't be opened right now".
 */

import {
  IV_BYTE_LENGTH,
  KEY_BYTE_LENGTH,
  KEY_ID_PATTERN,
  keyBytesFrom,
} from "../encryption/primitives.js";
import { LOGICAL_DELETE_CONTENT_TYPE } from "./index.js";

export const MANAGED_ENCRYPTION_MODES = Object.freeze(["migrating", "encrypted", "decrypting"]);

const MAGIC = new Uint8Array([0x43, 0x54, 0x58, 0x45, 0x4e, 0x43, 0x01]); // "CTXENC" v1
const WRAPPED_KEY_LENGTH = KEY_BYTE_LENGTH + 16;
const HKDF_INFO = "context-managed-storage-v1";
const encoder = new TextEncoder();

/** Why a managed object could not be opened. Carries no bytes and no key. */
export class ManagedEncryptionError extends Error {
  constructor(code, detail) {
    super(`managed storage encryption: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "ManagedEncryptionError";
    this.code = code;
  }
}

/**
 * Narrow the control plane's descriptor. Anything malformed is a refusal, not
 * "no encryption": a workspace the control plane says is encrypted must never
 * quietly be served as plain because one field was missing.
 *
 * @param {unknown} descriptor `{mode}` from the control plane, or null/undefined
 * @param {{current: string, keys: Record<string,string>}|null} dataKey
 * @returns {{mode: "migrating"|"encrypted"|"decrypting", current: string, keys: Record<string,string>}|null}
 */
export function readManagedEncryption(descriptor, dataKey) {
  if (descriptor === null || descriptor === undefined) return null;
  const mode = descriptor?.mode;
  if (!MANAGED_ENCRYPTION_MODES.includes(mode)) {
    throw new ManagedEncryptionError("MALFORMED_DESCRIPTOR");
  }
  const current = dataKey?.current;
  const keys = dataKey?.keys;
  if (typeof current !== "string" || !KEY_ID_PATTERN.test(current) || !keys?.[current]) {
    throw new ManagedEncryptionError("KEY_UNAVAILABLE");
  }
  return { mode, current, keys };
}

/** True when these bytes start with this format's magic. */
export function isManagedEnvelope(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < MAGIC.byteLength) return false;
  for (let i = 0; i < MAGIC.byteLength; i += 1) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

/**
 * One workspace's sealing and opening, with derived keys cached for the life
 * of the object (one request). Exported for the migration walk, which needs to
 * seal a plain object it read raw, and for tests.
 */
export class ManagedCipher {
  /**
   * @param {string} workspaceId
   * @param {{current: string, keys: Record<string,string>}} dataKey
   */
  constructor(workspaceId, dataKey) {
    if (typeof workspaceId !== "string" || !workspaceId) {
      throw new ManagedEncryptionError("MISSING_WORKSPACE");
    }
    this.workspaceId = workspaceId;
    this.current = dataKey.current;
    this.keys = dataKey.keys;
    /** @type {Map<string, Promise<CryptoKey>>} */
    this.derived = new Map();
  }

  storageKey(generation) {
    let pending = this.derived.get(generation);
    if (!pending) {
      const material = this.keys[generation];
      if (typeof material !== "string") {
        return Promise.reject(new ManagedEncryptionError("KEY_UNAVAILABLE", generation));
      }
      pending = deriveStorageKey(keyBytesFrom(material));
      this.derived.set(generation, pending);
    }
    return pending;
  }

  /** @param {Uint8Array} plain @returns {Promise<Uint8Array>} */
  async seal(plain) {
    const generation = this.current;
    const kek = await this.storageKey(generation);
    const objectKeyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTE_LENGTH));
    const wrapIv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
    const wrapped = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: wrapIv, additionalData: this.wrapAad(generation) },
        kek,
        objectKeyBytes,
      ),
    );
    const contentIv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
    const generationBytes = encoder.encode(generation);
    const header = concat(MAGIC, new Uint8Array([generationBytes.byteLength]), generationBytes, wrapIv, wrapped, contentIv);
    const objectKey = await crypto.subtle.importKey("raw", objectKeyBytes, "AES-GCM", false, ["encrypt"]);
    objectKeyBytes.fill(0);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: contentIv, additionalData: this.contentAad(header) },
        objectKey,
        plain,
      ),
    );
    return concat(header, ciphertext);
  }

  /** @param {Uint8Array} sealed @returns {Promise<Uint8Array>} */
  async open(sealed) {
    const parsed = parseEnvelope(sealed);
    const kek = await this.storageKey(parsed.generation);
    let objectKeyBytes;
    try {
      objectKeyBytes = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: parsed.wrapIv, additionalData: this.wrapAad(parsed.generation) },
          kek,
          parsed.wrapped,
        ),
      );
    } catch {
      throw new ManagedEncryptionError("ENCRYPTED_UNREADABLE", "wrapped key");
    }
    const objectKey = await crypto.subtle.importKey("raw", objectKeyBytes, "AES-GCM", false, ["decrypt"]);
    objectKeyBytes.fill(0);
    try {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: parsed.contentIv, additionalData: this.contentAad(parsed.header) },
          objectKey,
          parsed.ciphertext,
        ),
      );
    } catch {
      throw new ManagedEncryptionError("ENCRYPTED_UNREADABLE", "content");
    }
  }

  wrapAad(generation) {
    return encoder.encode(`context-storage-key-v1:${this.workspaceId}:${generation}`);
  }

  contentAad(header) {
    return concat(encoder.encode(`context-storage-v1:${this.workspaceId}:`), header);
  }
}

/**
 * HKDF-Expand (RFC 5869 section 2.3) for one 32-byte block: HMAC-SHA256 keyed
 * with the data key over `info || 0x01`. Extract is skipped because the data
 * key is already 32 uniformly random bytes, which section 3.3 allows. It is
 * spelled with HMAC rather than WebCrypto's HKDF so the gateway keeps its
 * source-level promise (`encryptionPassphrase.test.mjs`) that it calls no key
 * derivation function a passphrase could be fed through.
 */
async function deriveStorageKey(rootBytes) {
  const hmacKey = await crypto.subtle.importKey("raw", rootBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const block = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, concat(encoder.encode(HKDF_INFO), new Uint8Array([1]))));
  try {
    return await crypto.subtle.importKey("raw", block, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    block.fill(0);
  }
}

function parseEnvelope(bytes) {
  if (!isManagedEnvelope(bytes)) throw new ManagedEncryptionError("ENCRYPTED_UNREADABLE", "magic");
  let offset = MAGIC.byteLength;
  const generationLength = bytes[offset];
  offset += 1;
  const minimum = offset + generationLength + IV_BYTE_LENGTH + WRAPPED_KEY_LENGTH + IV_BYTE_LENGTH + 16;
  if (generationLength === 0 || bytes.byteLength < minimum) {
    throw new ManagedEncryptionError("ENCRYPTED_UNREADABLE", "truncated");
  }
  const generation = new TextDecoder().decode(bytes.subarray(offset, offset + generationLength));
  if (!KEY_ID_PATTERN.test(generation)) throw new ManagedEncryptionError("ENCRYPTED_UNREADABLE", "generation");
  offset += generationLength;
  const wrapIv = bytes.subarray(offset, offset + IV_BYTE_LENGTH);
  offset += IV_BYTE_LENGTH;
  const wrapped = bytes.subarray(offset, offset + WRAPPED_KEY_LENGTH);
  offset += WRAPPED_KEY_LENGTH;
  const contentIv = bytes.subarray(offset, offset + IV_BYTE_LENGTH);
  offset += IV_BYTE_LENGTH;
  return {
    generation,
    wrapIv,
    wrapped,
    contentIv,
    header: bytes.subarray(0, offset),
    ciphertext: bytes.subarray(offset),
  };
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function bytesOf(value) {
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value && typeof value.arrayBuffer === "function") return new Uint8Array(await value.arrayBuffer());
  if (value && typeof value.getReader === "function") return new Uint8Array(await new Response(value).arrayBuffer());
  throw new ManagedEncryptionError("UNSUPPORTED_BODY");
}

/** A content-free deletion marker is left plain by decision. */
function isMarkerWrite(options) {
  return options?.contentType === LOGICAL_DELETE_CONTENT_TYPE;
}

/**
 * Wrap a raw adapter so every body it stores is sealed and every body it
 * returns is opened. Sits directly on the adapter, beneath the logical-delete
 * and note-cap wrappers, so those see plain bytes and every caller above
 * `storeForBinding` is covered by construction.
 *
 * @param {import("./index.js").ContextStore} store
 * @param {{workspaceId: string, mode: "migrating"|"encrypted"|"decrypting", current: string, keys: Record<string,string>}} config
 */
export function withManagedEncryption(store, config) {
  const cipher = new ManagedCipher(config.workspaceId, config);
  const strict = config.mode === "encrypted";
  const sealsWrites = config.mode !== "decrypting";

  async function openObject(object) {
    if (!object) return object;
    const raw = new Uint8Array(await object.arrayBuffer());
    let plain;
    if (isManagedEnvelope(raw)) {
      plain = await cipher.open(raw);
    } else if (strict && object.contentType !== LOGICAL_DELETE_CONTENT_TYPE) {
      // Encrypted-only reads: a plain body here is either tampering or a
      // writer that bypassed this wrapper. Neither is served.
      throw new ManagedEncryptionError("ENCRYPTED_UNREADABLE", "plain object in encrypted workspace");
    } else {
      plain = raw;
    }
    const buffer = plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength);
    // Named fields rather than a spread: a native R2 object keeps its
    // metadata on getters a spread would drop.
    return {
      etag: object.etag,
      uploaded: object.uploaded,
      contentType: object.contentType ?? object.httpMetadata?.contentType,
      ...(object.httpMetadata ? { httpMetadata: object.httpMetadata } : {}),
      size: plain.byteLength,
      text: async () => new TextDecoder().decode(plain),
      arrayBuffer: async () => buffer,
    };
  }

  const wrapped = Object.create(store);
  Object.assign(wrapped, {
    managedEncryption: Object.freeze({ mode: config.mode }),
    async get(key, ...rest) {
      return await openObject(await store.get(key, ...rest));
    },
    async put(key, value, options) {
      if (!sealsWrites || isMarkerWrite(options)) return await store.put(key, value, options);
      const sealed = await cipher.seal(await bytesOf(value));
      return await store.put(key, sealed, options);
    },
  });
  if (typeof store.head === "function") {
    // A HEAD's size is the sealed size; nothing reads it as the body length
    // (`storageLayout.js` compares etags), so it is passed through unchanged.
    wrapped.head = (...args) => store.head(...args);
  }
  return wrapped;
}

/**
 * The factory option for one opened binding, from the control plane's
 * response: `managedEncryption` beside the binding (never inside it) plus the
 * workspace data key already sent for encrypted notes. `null` when the
 * workspace is not encrypted. A descriptor that names a mode but arrives
 * without a usable key refuses the whole store: serving it plain would be
 * the silent downgrade this feature exists to rule out.
 *
 * @param {{managedEncryption?: unknown, encryptionKey?: unknown}} opened
 * @param {string} workspaceId the id the gateway already checked against the binding
 * @param {(reason: string) => Error} refuse builds the caller's refusal
 */
export function managedEncryptionFor(opened, workspaceId, refuse) {
  try {
    const config = readManagedEncryption(opened?.managedEncryption, opened?.encryptionKey);
    return config === null ? null : { ...config, workspaceId };
  } catch (error) {
    if (error instanceof ManagedEncryptionError) throw refuse(`managed encryption: ${error.code}`);
    throw error;
  }
}
