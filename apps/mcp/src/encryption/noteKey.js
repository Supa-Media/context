/**
 * Opening a note key, and a body once the key is in hand — the one place each
 * of those is decided, shared by the workspace path and the passphrase path so
 * that a failure looks the same from both.
 */

import {
  IV_BYTE_LENGTH,
  KEY_BYTE_LENGTH,
  NoteCryptoError,
  RECIPIENT_WORKSPACE,
  contentAad,
  fromBase64Url,
  importAesKey,
  keyBytesFrom,
  wrapAad,
} from "./primitives.js";

function assertIv(bytes) {
  if (bytes.byteLength !== IV_BYTE_LENGTH) {
    throw new NoteCryptoError("envelope has a malformed IV");
  }
  return bytes;
}

/**
 * The note key bytes, from whichever workspace recipient this deployment holds
 * a key for.
 *
 * Two implementations of "which recipient opens this, and what does a failure
 * look like" would be two places for the failure to stop being uniform, so
 * `decryptNote` and everything below share this one.
 */
export async function unwrapWithWorkspaceKey(envelope, { workspaceId, keys }) {
  const recipient = workspaceRecipientFor(envelope, workspaceId, keys);
  return await unwrapNoteKey(recipient, keyBytesFrom(keys[recipient.id]), workspaceId);
}

/**
 * WHICH workspace recipient opens this envelope here — the selection half of
 * the function above, split out because a second caller needs it.
 *
 * `unwrapWithWorkspaceKey` reads a note; `rewrapWorkspaceRecipient` re-wraps
 * one, and has to know which entry of the array it opened in order to replace
 * that one and leave every other alone. Two copies of "which recipient opens
 * this, and what does a failure say" is exactly the drift the comment above
 * refuses, so there is one — and the rotation pass and the read path therefore
 * fail identically, including on the note this file's passphrase section is
 * about, which carries a passphrase recipient and no workspace one and is
 * refused by name rather than reported as a key that is merely missing.
 */
export function workspaceRecipientFor(envelope, workspaceId, keys) {
  if (envelope.aad !== contentAad(workspaceId)) {
    throw new NoteCryptoError("this envelope is bound to a different context");
  }
  if (!keys || typeof keys !== "object") {
    throw new NoteCryptoError("no workspace data key available");
  }
  const recipient = envelope.recipients.find(
    (candidate) =>
      candidate.kind === RECIPIENT_WORKSPACE &&
      Object.prototype.hasOwnProperty.call(keys, candidate.id),
  );
  if (recipient === undefined) {
    throw new NoteCryptoError(
      envelope.recipients.some((candidate) => candidate.kind === RECIPIENT_WORKSPACE)
        ? "no workspace data key in this deployment opens that note; the key generation it names is not configured"
        : "that note is protected by a passphrase and carries no workspace recipient; nothing here can open it",
    );
  }
  return recipient;
}

/**
 * A note key, unwrapped from one recipient with the key that recipient names.
 *
 * One failure for every reason it can fail — a wrong key, a wrong workspace, a
 * tampered wrap, a passphrase that is not the passphrase. **That uniformity is
 * the security property of this function**, and it is what makes a wrong
 * passphrase indistinguishable from a corrupted envelope: distinguishing them
 * hands an attacker an oracle that says "keep guessing, you have the right
 * file", and hands a person who mistyped their passphrase no more than "that
 * did not open it", which is all there is to tell them anyway.
 */
export async function unwrapNoteKey(recipient, kek, workspaceId) {
  let noteKeyBytes;
  try {
    noteKeyBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: assertIv(fromBase64Url(recipient.iv)),
          additionalData: new TextEncoder().encode(wrapAad(workspaceId)),
        },
        await importAesKey(kekBytesFrom(kek)),
        fromBase64Url(recipient.wrapped),
      ),
    );
  } catch (error) {
    if (error instanceof NoteCryptoError) throw error;
    throw new NoteCryptoError("failed to unwrap the note key");
  }
  if (noteKeyBytes.byteLength !== KEY_BYTE_LENGTH) {
    throw new NoteCryptoError("failed to unwrap the note key");
  }
  return noteKeyBytes;
}

/** The content half of a decrypt, once a note key is in hand. */
export async function openContent(envelope, noteKeyBytes) {
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: assertIv(fromBase64Url(envelope.iv)),
        additionalData: new TextEncoder().encode(envelope.aad),
      },
      await importAesKey(noteKeyBytes),
      fromBase64Url(envelope.ct),
    );
  } catch (error) {
    if (error instanceof NoteCryptoError) throw error;
    throw new NoteCryptoError("failed to decrypt the note");
  }
  return new TextDecoder().decode(plaintext);
}

/**
 * 32 bytes from a key-encryption key given as bytes or as base64.
 *
 * Bytes are the honest shape for something a KDF has just produced; base64 is
 * the shape it arrives in when a test pins one. Both land as the same 32 bytes
 * or neither does.
 */
export function kekBytesFrom(kek) {
  if (kek instanceof Uint8Array) {
    if (kek.byteLength !== KEY_BYTE_LENGTH) {
      throw new NoteCryptoError(`a key-encryption key must be ${KEY_BYTE_LENGTH} bytes`);
    }
    return kek;
  }
  return keyBytesFrom(kek);
}
