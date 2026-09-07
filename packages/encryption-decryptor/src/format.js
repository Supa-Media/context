/**
 * An independent reimplementation of the envelope and key-export formats
 * specified in `docs/decisions/encryption.md` — "The on-bucket format" and
 * "Revocation and export".
 *
 * **Independent on purpose.** This does not import `apps/mcp/src/encryption.js`.
 * The whole point of a written spec is that a third party — this package,
 * treated as though it were one — can open their own notes from the spec and
 * a Web Crypto implementation alone, with no help from the code that wrote
 * them. If this module quietly depended on the gateway's own module, a
 * format bug shared by both would never be caught by anything, which is
 * exactly backwards for the one artifact whose entire job is to outlive the
 * gateway. `test/decrypt.test.mjs` proves the independence is real: it
 * encrypts with the gateway's own code and opens the result with this one.
 *
 * Pure `globalThis.crypto.subtle` (Node's Web Crypto, available without a
 * flag since Node 20) and standard library string/array handling only. No
 * npm dependency, here or transitively.
 */

const IV_BYTE_LENGTH = 12;
const KEY_BYTE_LENGTH = 32;
const CONTENT_ALG = "A256GCM";
const ENVELOPE_VERSION = 1;
const KEY_EXPORT_VERSION = 1;
const MARKER_KEY = "context_encryption";
const FENCE_LANGUAGE = "context-encrypted";
const RECIPIENT_WORKSPACE = "workspace";

export class DecryptorError extends Error {
  constructor(message) {
    super(message);
    this.name = "DecryptorError";
  }
}

/* ------------------------------ base64url --------------------------------- */

function fromBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new DecryptorError("envelope field is not base64url");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const buffer = Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
  return new Uint8Array(buffer);
}

function fromBase64(value) {
  if (typeof value !== "string") throw new DecryptorError("key material must be a base64 string");
  const buffer = Buffer.from(value, "base64");
  if (buffer.length !== KEY_BYTE_LENGTH) {
    throw new DecryptorError(`a workspace data key must be ${KEY_BYTE_LENGTH} bytes (base64-encoded AES-256)`);
  }
  return new Uint8Array(buffer);
}

/* -------------------------------- notes ------------------------------------ */

function withoutBom(text) {
  if (typeof text !== "string") return null;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Whether a note's text carries the encryption marker, without parsing further. */
export function isEncryptedNote(text) {
  const body = withoutBom(text);
  if (body === null || !body.startsWith("---")) return false;
  const end = body.indexOf("\n---", 3);
  if (end < 0) return false;
  return new RegExp(`^\\s*${MARKER_KEY}\\s*:\\s*v?\\d+\\s*$`, "m").test(body.slice(3, end));
}

/**
 * Extract the JSON envelope from an encrypted note's text.
 *
 * `null` for a note with no marker at all — an ordinary note. Throws for one
 * that claims to be encrypted and cannot be read as one, matching the
 * gateway's own asymmetry: a broken envelope must never be handed back as
 * though it were a readable one.
 */
export function parseEncryptedNote(text) {
  if (!isEncryptedNote(text)) return null;
  const body = withoutBom(text);

  const fence = "```" + FENCE_LANGUAGE;
  const start = body.indexOf(fence);
  if (start < 0) throw new DecryptorError("encrypted note has no envelope block");
  const bodyStart = body.indexOf("\n", start);
  if (bodyStart < 0) throw new DecryptorError("encrypted note has no envelope block");
  const end = body.indexOf("\n```", bodyStart);
  if (end < 0) throw new DecryptorError("encrypted note has an unterminated envelope block");

  let envelope;
  try {
    envelope = JSON.parse(body.slice(bodyStart + 1, end));
  } catch {
    throw new DecryptorError("encrypted note has a malformed envelope");
  }
  return assertEnvelopeShape(envelope);
}

function assertEnvelopeShape(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new DecryptorError("encrypted note has a malformed envelope");
  }
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new DecryptorError(`unsupported envelope version ${JSON.stringify(envelope.v)}`);
  }
  if (envelope.alg !== CONTENT_ALG) {
    throw new DecryptorError(`unsupported envelope algorithm ${JSON.stringify(envelope.alg)}`);
  }
  if (typeof envelope.aad !== "string" || envelope.aad.length === 0) {
    throw new DecryptorError("envelope is missing its associated data");
  }
  if (typeof envelope.iv !== "string" || typeof envelope.ct !== "string") {
    throw new DecryptorError("envelope is missing its ciphertext");
  }
  if (!Array.isArray(envelope.recipients) || envelope.recipients.length === 0) {
    throw new DecryptorError("envelope has no recipients");
  }
  for (const recipient of envelope.recipients) {
    if (!recipient || typeof recipient !== "object" || Array.isArray(recipient)) {
      throw new DecryptorError("envelope has a malformed recipient");
    }
    if (typeof recipient.kind !== "string" || typeof recipient.id !== "string") {
      throw new DecryptorError("envelope has a malformed recipient");
    }
    if (recipient.alg !== CONTENT_ALG) {
      throw new DecryptorError("envelope has a recipient with an unsupported algorithm");
    }
    if (typeof recipient.iv !== "string" || typeof recipient.wrapped !== "string") {
      throw new DecryptorError("envelope has a malformed recipient");
    }
  }
  return envelope;
}

async function importAesKey(bytes) {
  return await globalThis.crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["decrypt"]);
}

function assertIv(bytes) {
  if (bytes.byteLength !== IV_BYTE_LENGTH) throw new DecryptorError("envelope has a malformed IV");
  return bytes;
}

/**
 * Open an encrypted note's envelope back to its plaintext.
 *
 * `keys` maps a key generation id to base64 AES-256 material — exactly the
 * shape a key export's `keys` array reduces to, and exactly what a
 * deployment mid-rotation needs: a note may name a generation from before the
 * workspace's most recent rotation, and this opens it all the same as long
 * as that generation's material is present.
 *
 * The associated data is read from the envelope's own `aad` field and used
 * as-is, exactly as the format's own header comment promises — this module
 * never reconstructs it from a rule written in prose, which is the whole
 * point of storing it as a literal.
 *
 * @param {string} noteText the note exactly as it sits in the bucket
 * @param {Record<string,string>} keys generation id -> base64 key material
 * @returns {Promise<string>} the note's plaintext
 */
export async function decryptNote(noteText, keys) {
  const envelope = parseEncryptedNote(noteText);
  if (envelope === null) throw new DecryptorError("that note is not encrypted");
  if (!keys || typeof keys !== "object") throw new DecryptorError("no key material supplied");

  const recipient = envelope.recipients.find(
    (candidate) =>
      candidate.kind === RECIPIENT_WORKSPACE && Object.prototype.hasOwnProperty.call(keys, candidate.id),
  );
  if (recipient === undefined) {
    throw new DecryptorError(
      "no supplied key opens that note; it names a generation not present in this export",
    );
  }

  const wrappingKey = await importAesKey(fromBase64(keys[recipient.id]));
  const wrapAad = new TextEncoder().encode(`context-note-key-v1:${envelopeWorkspaceId(envelope)}`);
  let noteKeyBytes;
  try {
    noteKeyBytes = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: assertIv(fromBase64Url(recipient.iv)), additionalData: wrapAad },
        wrappingKey,
        fromBase64Url(recipient.wrapped),
      ),
    );
  } catch {
    throw new DecryptorError("failed to unwrap the note key — wrong key, or a tampered envelope");
  }
  if (noteKeyBytes.byteLength !== KEY_BYTE_LENGTH) {
    throw new DecryptorError("failed to unwrap the note key");
  }

  const noteKey = await importAesKey(noteKeyBytes);
  let plaintext;
  try {
    plaintext = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: assertIv(fromBase64Url(envelope.iv)),
        additionalData: new TextEncoder().encode(envelope.aad),
      },
      noteKey,
      fromBase64Url(envelope.ct),
    );
  } catch {
    throw new DecryptorError("failed to decrypt the note — tampered ciphertext, or the wrong context");
  }
  return new TextDecoder().decode(plaintext);
}

/**
 * The workspace id an envelope is bound to, read out of its own `aad` field
 * (`context-note-v1:<workspaceId>`) rather than supplied separately — an
 * offline decryptor has no other source for it, and the format's whole
 * design (see `docs/decisions/encryption.md`, "The AAD binds the workspace")
 * is that the envelope carries everything needed to open it.
 */
function envelopeWorkspaceId(envelope) {
  const prefix = "context-note-v1:";
  if (!envelope.aad.startsWith(prefix)) {
    throw new DecryptorError("envelope's associated data is not in the expected form");
  }
  return envelope.aad.slice(prefix.length);
}

/* ----------------------------- key export ---------------------------------- */

/**
 * Parse and validate an exported key bundle — the document
 * `export_encryption_keys` and the console's export action both produce.
 *
 * @param {unknown} doc parsed JSON, not yet trusted
 * @returns {{workspaceId: string, current: string, keys: Record<string,string>}}
 */
export function parseKeyExport(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new DecryptorError("key export is not a JSON object");
  }
  if (doc.v !== KEY_EXPORT_VERSION) {
    throw new DecryptorError(`unsupported key export version ${JSON.stringify(doc.v)}`);
  }
  if (typeof doc.workspace_id !== "string" || doc.workspace_id.length === 0) {
    throw new DecryptorError("key export is missing workspace_id");
  }
  if (typeof doc.current !== "string" || doc.current.length === 0) {
    throw new DecryptorError("key export is missing current");
  }
  if (!Array.isArray(doc.keys) || doc.keys.length === 0) {
    throw new DecryptorError("key export has no keys");
  }
  const keys = {};
  for (const entry of doc.keys) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DecryptorError("key export has a malformed key entry");
    }
    if (typeof entry.generation !== "string" || typeof entry.key !== "string") {
      throw new DecryptorError("key export has a malformed key entry");
    }
    if (entry.alg !== CONTENT_ALG) {
      throw new DecryptorError(`key export entry has an unsupported algorithm ${JSON.stringify(entry.alg)}`);
    }
    fromBase64(entry.key); // shape-validates without holding onto a second copy
    keys[entry.generation] = entry.key;
  }
  if (!Object.prototype.hasOwnProperty.call(keys, doc.current)) {
    throw new DecryptorError("key export's current generation is not among its own keys");
  }
  return { workspaceId: doc.workspace_id, current: doc.current, keys };
}
