/**
 * The `workspace` recipient: encrypting a note under the workspace's data key,
 * opening it again, and re-wrapping it under a new key generation.
 */

import {
  CONTENT_ALG,
  ENVELOPE_VERSION,
  IV_BYTE_LENGTH,
  KEY_BYTE_LENGTH,
  NoteCryptoError,
  RECIPIENT_WORKSPACE,
  contentAad,
  importAesKey,
  keyBytesFrom,
  requireKeyId,
  toBase64Url,
  wrapAad,
} from "./primitives.js";
import { parseEncryptedNote, renderEncryptedNote } from "./format.js";
import {
  openContent,
  unwrapNoteKey,
  unwrapWithWorkspaceKey,
  workspaceRecipientFor,
} from "./noteKey.js";

/* ------------------------------- encrypt --------------------------------- */

/**
 * Encrypt a note's plaintext into the document that gets stored at its path.
 *
 * A fresh note key per call and a fresh IV per key. Encrypting the same note
 * twice produces different bytes, so nobody reading the bucket can tell that
 * two notes — or two versions of one note — have the same content.
 *
 * @param {string} plaintext the whole note, frontmatter included
 * @param {{workspaceId: string, workspaceKey: string, keyId: string}} context
 * @returns {Promise<string>} the document to store
 */
export async function encryptNote(plaintext, { workspaceId, workspaceKey, keyId }) {
  if (typeof plaintext !== "string") {
    throw new NoteCryptoError("a note's plaintext must be a string");
  }
  const aad = contentAad(workspaceId);
  const generation = requireKeyId(keyId);
  const wrappingKey = await importAesKey(keyBytesFrom(workspaceKey));

  const noteKeyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTE_LENGTH));
  const noteKey = await importAesKey(noteKeyBytes);

  const contentIv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: contentIv, additionalData: new TextEncoder().encode(aad) },
      noteKey,
      new TextEncoder().encode(plaintext),
    ),
  );

  const wrapIv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: wrapIv,
        additionalData: new TextEncoder().encode(wrapAad(workspaceId)),
      },
      wrappingKey,
      noteKeyBytes,
    ),
  );

  return renderEncryptedNote({
    v: ENVELOPE_VERSION,
    alg: CONTENT_ALG,
    iv: toBase64Url(contentIv),
    ct: toBase64Url(ciphertext),
    aad,
    recipients: [
      {
        kind: RECIPIENT_WORKSPACE,
        id: generation,
        alg: CONTENT_ALG,
        iv: toBase64Url(wrapIv),
        wrapped: toBase64Url(wrapped),
      },
    ],
  });
}

/* ------------------------------- decrypt --------------------------------- */

/**
 * Open an encrypted note back to its plaintext.
 *
 * `keys` maps a generation id to base64 key material, so a deployment
 * mid-rotation can read notes written under either without the caller having to
 * know which. The gateway passes `{ [keyId]: material }` today; the shape is
 * what makes rotation a re-wrap pass rather than a format change.
 *
 * @param {string} stored the document as it sits in the bucket
 * @param {{workspaceId: string, keys: Record<string,string>}} context
 * @returns {Promise<string>} the note's plaintext
 */
export async function decryptNote(stored, { workspaceId, keys }) {
  const envelope = parseEncryptedNote(stored);
  if (envelope === null) throw new NoteCryptoError("that note is not encrypted");
  // Both halves live in one place each — `unwrapWithWorkspaceKey` decides which
  // recipient opens this and what a failure says, `openContent` does the body —
  // so the passphrase path below cannot drift away from this one on either.
  return await openContent(envelope, await unwrapWithWorkspaceKey(envelope, { workspaceId, keys }));
}

/* -------------------------------- rotation -------------------------------- */

/**
 * Re-wrap one note's `workspace` recipient under a new key generation,
 * without decrypting — or re-encrypting — the note's body.
 *
 * This is the entire cost of a workspace-key rotation, per note: unwrap the
 * note key with whatever generation currently opens it, wrap the same bytes
 * again under the new generation's key, and rewrite the frontmatter marker so
 * a future pass can tell this note is done. `ct`, `iv` and `aad` on the
 * envelope — the actual content — are copied through unchanged. A rotation
 * that decrypted and re-encrypted the body instead would turn "rotate the
 * workspace key" into "re-encrypt every note in the bucket", which
 * `docs/decisions/encryption.md` names as the cost a per-note key exists to
 * avoid.
 *
 * Any non-`workspace` recipient — a future `passphrase` one — is copied
 * through untouched: rotating the workspace's own key does not, and must not,
 * disturb a recipient wrapped under a key this workspace does not hold.
 *
 * Idempotent by construction rather than by a caller's care: a note already
 * on `newGeneration` unwraps with `newKeyMaterial` (present in `keys`) and
 * re-wraps to the same bytes it already had, modulo IV — safe to call twice,
 * and safe for a resumed walk to call again on a note the last pass already
 * moved.
 *
 * @param {string} stored the document as it sits in the bucket
 * @param {{workspaceId: string, keys: Record<string,string>, newGeneration: string, newKeyMaterial: string}} context
 *   `keys` must include an entry for whatever generation the note is
 *   currently wrapped under — every live (non-purged) generation, in
 *   practice — so a note several generations behind still re-wraps in one
 *   step straight to the current one.
 * @returns {Promise<string>} the document to store, unchanged but for the
 *   `workspace` recipient and the frontmatter marker naming its generation.
 */
export async function rewrapWorkspaceRecipient(
  stored,
  { workspaceId, keys, newGeneration, newKeyMaterial },
) {
  const envelope = parseEncryptedNote(stored);
  if (envelope === null) throw new NoteCryptoError("that note is not encrypted");
  const generation = requireKeyId(newGeneration);

  // The same selection the read path makes, so a note this refuses to re-wrap
  // is exactly a note it refuses to read, with the same words - including a
  // passphrase-only note, which has no workspace recipient to move and is
  // named as such rather than reported as a key that went missing.
  const current = workspaceRecipientFor(envelope, workspaceId, keys);
  const noteKeyBytes = await unwrapNoteKey(
    current,
    keyBytesFrom(keys[current.id]),
    workspaceId,
  );

  const wrappingKey = await importAesKey(keyBytesFrom(newKeyMaterial));
  const wrapIv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: wrapIv,
        additionalData: new TextEncoder().encode(wrapAad(workspaceId)),
      },
      wrappingKey,
      noteKeyBytes,
    ),
  );

  // Matched by identity, not by index or by id: `current` is the very object
  // the selection returned, so the entry replaced is the entry opened, and
  // every other recipient - a `passphrase` one above all - is the same object
  // it was.
  const recipients = envelope.recipients.map((existing) =>
    existing === current
      ? {
          kind: RECIPIENT_WORKSPACE,
          id: generation,
          alg: CONTENT_ALG,
          iv: toBase64Url(wrapIv),
          wrapped: toBase64Url(wrapped),
        }
      : existing,
  );

  return renderEncryptedNote({ ...envelope, recipients });
}
