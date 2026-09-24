import {
  CONTENT_ALG,
  ENVELOPE_VERSION,
  IV_BYTE_LENGTH,
  KEY_BYTE_LENGTH,
  NoteCryptoError,
  RECIPIENT_PASSPHRASE,
  contentAad,
  importAesKey,
  keyBytesFrom,
  requireKeyId,
  toBase64,
  toBase64Url,
  wrapAad,
} from "./primitives.js";
import {
  assertEnvelopeShape,
  assertKdfDescriptor,
  parseEncryptedNote,
  renderEncryptedNote,
} from "./format.js";
import { kekBytesFrom, openContent, unwrapNoteKey } from "./noteKey.js";

/* ------------------------------ passphrase ------------------------------- */
//
// Phase 2, and a different product from the section above it.
//
// A `workspace` recipient makes a note unreadable to a storage provider and
// readable to everything the customer has connected. A `passphrase` recipient
// makes it unreadable to *us*: only somebody who knows the passphrase opens it,
// the passphrase is nowhere, and a note carrying one carries **no workspace
// recipient at all**. `docs/decisions/encryption.md`, "Encrypted notes are for
// humans", is the decision and states what it costs — no AI client can read one.
//
// **The whole of this section runs on a client and none of it runs in the
// gateway.** The boundary is drawn as a parameter type: every function here
// takes a `kek` — 32 raw bytes, or the base64 of them — and not one takes a
// passphrase, because turning a passphrase into a key is a KDF, a KDF is not in
// this file, and it is not reachable from the Worker at all. Two checks hold
// that: the gateway suite asserts no exported signature here takes a
// passphrase, and it asserts that `src/index.js` never calls any of it.
//
// They live here anyway, rather than in the console, because this module is the
// **normative decryptor** — the file a customer runs to read their own notes
// without us. A spec that could open half the envelopes it defines would not be
// one.

/**
 * Encrypt a note so that **only a passphrase opens it**.
 *
 * The whole envelope, produced in one call: a fresh note key, the body sealed
 * under it, and exactly one recipient — the passphrase. There is no `workspace`
 * recipient, deliberately and by definition, and that is what makes this the
 * mode the product note asked for rather than encryption at rest wearing a
 * password. Nothing we run can open the result. Neither can any AI client the
 * customer has connected, which is the trade stated in
 * `docs/decisions/encryption.md`, "Encrypted notes are for humans".
 *
 * It runs wherever the passphrase was typed — the console, or somebody's own
 * decryptor — and it is in this module because this module is the spec. **The
 * gateway does not call it, and `index.js` is asserted not to.**
 *
 * @param {string} plaintext the whole note, frontmatter included
 * @param {{workspaceId: string, kek: Uint8Array|string, kdf: object, id?: string}} context
 */
export async function encryptNoteForPassphrase(plaintext, { workspaceId, kek, kdf, id = "p1" }) {
  if (typeof plaintext !== "string") {
    throw new NoteCryptoError("a note's plaintext must be a string");
  }
  const aad = contentAad(workspaceId);
  const noteKeyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTE_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
      await importAesKey(noteKeyBytes),
      new TextEncoder().encode(plaintext),
    ),
  );
  const recipient = await wrapNoteKeyForPassphrase(toBase64(noteKeyBytes), kek, {
    workspaceId,
    id,
    kdf,
  });
  noteKeyBytes.fill(0);
  return renderEncryptedNote({
    v: ENVELOPE_VERSION,
    alg: CONTENT_ALG,
    iv: toBase64Url(iv),
    ct: toBase64Url(ciphertext),
    aad,
    recipients: [recipient],
  });
}

/** The recipients an encrypted note carries, or `[]` for an ordinary note. */
export function recipientsOf(stored) {
  const envelope = parseEncryptedNote(stored);
  return envelope === null ? [] : envelope.recipients;
}

/** Does this note carry a recipient of `kind` (and, given one, that `id`)? */
export function hasRecipient(stored, kind, id) {
  return recipientsOf(stored).some(
    (recipient) => recipient.kind === kind && (id === undefined || recipient.id === id),
  );
}

/**
 * Wrap a note key for a passphrase-derived key.
 *
 * The KDF descriptor is written into the recipient rather than assumed, because
 * a decryptor five years from now — ours, somebody else's, or a person with the
 * spec and a weekend — has to derive the same key without knowing what this
 * build's defaults were. Same reason `aad` is a literal in the envelope rather
 * than a rule in prose.
 *
 * @param {string} noteKey base64 note key, as `noteKeyOf` returns it
 * @param {Uint8Array|string} kek 32 bytes derived from the passphrase, client-side
 * @param {{workspaceId: string, id?: string, kdf: object}} context
 */
export async function wrapNoteKeyForPassphrase(noteKey, kek, { workspaceId, id = "p1", kdf }) {
  const recipientId = requireKeyId(id);
  const descriptor = assertKdfDescriptor(kdf);
  const noteKeyBytes = keyBytesFrom(noteKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(wrapAad(workspaceId)),
      },
      await importAesKey(kekBytesFrom(kek)),
      noteKeyBytes,
    ),
  );
  return {
    kind: RECIPIENT_PASSPHRASE,
    id: recipientId,
    alg: CONTENT_ALG,
    iv: toBase64Url(iv),
    wrapped: toBase64Url(wrapped),
    // A fresh object rather than the caller's, carrying exactly the six fields
    // the format defines. Copying the caller's would put whatever else it
    // happened to hold into the envelope of every note it touched.
    kdf: {
      id: descriptor.id,
      v: descriptor.v,
      m: descriptor.m,
      t: descriptor.t,
      p: descriptor.p,
      salt: descriptor.salt,
    },
  };
}

/**
 * Open a note with a passphrase-derived key.
 *
 * The mirror of `decryptNote`, and deliberately a separate function rather than
 * an argument to it: the workspace path runs in the gateway with a key from the
 * control plane, and this one runs wherever somebody typed their passphrase.
 * One function taking either would be one function that could be handed the
 * wrong one.
 */
export async function decryptNoteWithPassphrase(stored, { workspaceId, kek, id }) {
  const envelope = parseEncryptedNote(stored);
  if (envelope === null) throw new NoteCryptoError("that note is not encrypted");
  if (envelope.aad !== contentAad(workspaceId)) {
    throw new NoteCryptoError("this envelope is bound to a different context");
  }
  const recipient = envelope.recipients.find(
    (candidate) =>
      candidate.kind === RECIPIENT_PASSPHRASE && (id === undefined || candidate.id === id),
  );
  if (recipient === undefined) {
    throw new NoteCryptoError("that note has no passphrase recipient");
  }
  return await openContent(envelope, await unwrapNoteKey(recipient, kek, workspaceId));
}

/**
 * The same note, with one recipient replaced by another of the same name.
 *
 * This is a passphrase change, and it is what the wrapped note key was bought
 * for: the body is untouched, so changing a passphrase costs one small write
 * per note and cannot half-finish into a note nobody can open.
 */
export function replacingRecipient(stored, recipient) {
  const envelope = parseEncryptedNote(stored);
  if (envelope === null) throw new NoteCryptoError("that note is not encrypted");
  assertRecipientShape(recipient);
  let replaced = false;
  const recipients = envelope.recipients.map((existing) => {
    if (existing.kind !== recipient.kind || existing.id !== recipient.id) return existing;
    replaced = true;
    return recipient;
  });
  if (!replaced) throw new NoteCryptoError("that note carries no such recipient");
  return renderEncryptedNote({ ...envelope, recipients });
}

/**
 * Structural validation of a recipient a *caller* supplied, rather than one
 * read out of a bucket.
 *
 * The same checks `assertEnvelopeShape` makes on the way in, made again on the
 * way out, because the three functions above are the only place a recipient
 * enters an envelope from outside this module — and a client that can put an
 * unparseable recipient into somebody's note has found a way to make that note
 * permanently unreadable through a call named "add a passphrase".
 */
function assertRecipientShape(recipient) {
  assertEnvelopeShape({
    v: ENVELOPE_VERSION,
    alg: CONTENT_ALG,
    aad: "probe",
    iv: "",
    ct: "",
    recipients: [recipient],
  });
  return recipient;
}
