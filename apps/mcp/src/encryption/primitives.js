/**
 * The envelope's vocabulary: its constants, its one error type, base64 in
 * both alphabets, key material, the associated-data literals, and key
 * generation. Everything else in `src/encryption/` is built from these.
 *
 * Imports nothing, like every file in this folder. See `../encryption.js`.
 */

/** Envelope version. A version this build does not know is refused, never guessed. */
export const ENVELOPE_VERSION = 1;

/** The content AEAD in v1. Web Crypto's AES-GCM, 256-bit key, 96-bit IV. */
export const CONTENT_ALG = "A256GCM";

/** The frontmatter key a human, a plugin, or a `grep` reads. */
export const MARKER_KEY = "context_encryption";

/** The frontmatter key naming the generation of the key that wrapped this note. */
export const KEY_MARKER_KEY = "context_encryption_key";

/**
 * The fence language. No renderer highlights it and nothing executes it, which
 * is the point: the body of an encrypted note must be inert everywhere it is
 * displayed.
 */
export const FENCE_LANGUAGE = "context-encrypted";

/** The recipient kind the gateway wraps for. One per workspace key generation. */
export const RECIPIENT_WORKSPACE = "workspace";

/**
 * The key export format version. Independent of `ENVELOPE_VERSION`: an export
 * bundles zero or more note-envelope-openers, it is not itself a note envelope,
 * and the two have no reason to change together.
 */
export const KEY_EXPORT_VERSION = 1;

/**
 * The recipient kind a passphrase opens.
 *
 * The key that unwraps it is derived **on the client**, from a passphrase this
 * gateway never receives and could not use if it did. Everything in this module
 * about a passphrase recipient therefore takes a key-encryption key as bytes
 * that somebody else derived: there is no passphrase parameter anywhere in this
 * file, and that absence is the security property.
 */
export const RECIPIENT_PASSPHRASE = "passphrase";

/** The only KDF a v1 passphrase recipient may name. */
export const KDF_ARGON2ID = "argon2id";

/**
 * Bounds on what a KDF descriptor read out of a bucket may ask a client to do.
 *
 * A passphrase recipient's parameters are attacker-controlled in exactly one
 * scenario, and it is the scenario this whole feature is about: somebody who
 * can write the customer's bucket. They cannot forge a wrap — they do not have
 * the passphrase — but without these bounds they could write `m: 4194304` and
 * make the console allocate four gigabytes, or `t: 1000000` and hang it, on
 * every unlock attempt. A file in a bucket does not get to choose how much
 * memory a device spends.
 *
 * The ceilings are deliberately far above anything shipped (see
 * `docs/decisions/encryption.md`, "The KDF, per client") so that raising the
 * parameters later is a parameter change and not a format change.
 */
export const KDF_LIMITS = Object.freeze({
  /** KiB. 2 GiB, RFC 9106's own first recommended option. */
  maxMemory: 2 * 1024 * 1024,
  /** KiB. Argon2's own floor is 8 KiB per lane. */
  minMemory: 8,
  maxIterations: 16,
  maxParallelism: 16,
  minSaltBytes: 8,
  maxSaltBytes: 64,
});

/** 96 bits, the GCM-recommended nonce size. */
export const IV_BYTE_LENGTH = 12;
/** AES-256. */
export const KEY_BYTE_LENGTH = 32;

/**
 * A key generation id, as it appears in `ws:<id>` in the frontmatter and in a
 * recipient's `id`. The same charset the control plane's envelope key ids use,
 * for the same reason: it is operator-chosen configuration inside a delimited
 * string, not user input, so there is no reason for it to be exotic.
 */
export const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Thrown for every envelope, key and format problem.
 *
 * The message never contains key material, plaintext, or ciphertext. It is
 * allowed to say which *shape* was wrong, because this is an operator- and
 * owner-facing error rather than an attacker-facing oracle: reaching it at all
 * requires already having passed `canSee`.
 */
export class NoteCryptoError extends Error {
  constructor(message) {
    super(message);
    this.name = "NoteCryptoError";
  }
}

/**
 * A bucket-controlled value, rendered small enough to put in a message.
 *
 * `v` and `alg` are read out of a file in the customer's bucket, and the error
 * that names them reaches a structured log line and — past `canSee` — a client.
 * Interpolating them verbatim would let a file decide the size and the content
 * of a log record, which is the one thing a log line is not allowed to let a
 * note do. Shapes and short prefixes are enough to debug with; the rest is
 * somebody's bytes.
 */
export function describeField(value) {
  if (typeof value === "string") {
    return value.length <= 16
      ? JSON.stringify(value)
      : `${JSON.stringify(value.slice(0, 16))}\u2026`;
  }
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}

/* ------------------------------ base64url -------------------------------- */
//
// Unpadded base64url throughout the envelope, so it survives a URL, a YAML
// scalar and a JSON string with no escaping anywhere. (Nothing here is *put*
// in a URL — see the decision — but a format that would break if somebody did
// is a format with a trap in it.)

export function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new NoteCryptoError("envelope field is not base64url");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  let binary;
  try {
    binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  } catch {
    throw new NoteCryptoError("envelope field is not base64url");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Base64 (standard alphabet), for keys that cross a JSON boundary as configuration. */
export function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function keyBytesFrom(material) {
  if (typeof material !== "string" || material.length === 0) {
    throw new NoteCryptoError("a workspace data key must be a base64 string");
  }
  // Accept either alphabet. An operator pasting an exported key should not have
  // to know which one we chose, and the two are unambiguous on decode.
  const normalized = material.replace(/-/g, "+").replace(/_/g, "/");
  let binary;
  try {
    binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  } catch {
    throw new NoteCryptoError("a workspace data key must be a base64 string");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (bytes.byteLength !== KEY_BYTE_LENGTH) {
    throw new NoteCryptoError(
      `a workspace data key must be ${KEY_BYTE_LENGTH} bytes (base64-encoded AES-256)`,
    );
  }
  return bytes;
}

export async function importAesKey(bytes) {
  return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/* --------------------------- associated data ----------------------------- */

/**
 * The bytes GCM authenticates alongside the note body.
 *
 * Stored in the envelope as a literal string so a third-party decryptor never
 * has to reconstruct it from a rule written in prose. It is still *checked*
 * against what this workspace expects before use: GCM would refuse a relabelled
 * envelope anyway, but an explicit comparison turns "authentication failed"
 * into "this envelope belongs to another context", which is the difference
 * between a bug report and a mystery.
 */
export function contentAad(workspaceId) {
  return `context-note-v1:${requireWorkspaceId(workspaceId)}`;
}

/** The same, for the wrapped note key. A different literal, so the two can never cross. */
export function wrapAad(workspaceId) {
  return `context-note-key-v1:${requireWorkspaceId(workspaceId)}`;
}

export function requireWorkspaceId(workspaceId) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new NoteCryptoError("an encrypted note must be bound to a workspace id");
  }
  return workspaceId;
}

export function requireKeyId(keyId) {
  if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId)) {
    throw new NoteCryptoError(`a key generation id must match ${KEY_ID_PATTERN.source}`);
  }
  return keyId;
}

/* ------------------------------ generation ------------------------------- */

/**
 * A fresh workspace data key, base64.
 *
 * For the control plane's get-or-create path and for tests. The output is
 * sealed into a `v2:` envelope immediately and never stored, logged or returned
 * in the clear except through the owner's own deliberate export.
 */
export function generateWorkspaceKey() {
  return toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTE_LENGTH)));
}
