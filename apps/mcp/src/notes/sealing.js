/**
 * Opening and sealing stored notes under workspace encryption, and writing
 * gateway-generated notes. `sealNoteContent` is the one place a write decides
 * whether it may replace an encrypted note. Moved verbatim out of `src/index.js`.
 */

import {
  eligible as collaborationEligible,
  supported as collaborationSupported,
  readDocument as readCollaborationDocument,
  replaceText as replaceCollaborationText,
} from "@context/collaboration";
import {
  decryptNote,
  encryptNote,
  generatedNoteBytes,
  isEncryptedNote,
  NoteCryptoError,
} from "../encryption.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { toolError } from "../tools/results.js";

/* ------------------------------ encryption ------------------------------- */
//
// `docs/decisions/encryption.md`. Three rules live here and nowhere else:
//
//  1. **`canSee` runs first, always.** Encryption is confidentiality, not access
//     control. Nothing below is reached by a caller who could not already read
//     the note, so an encrypted note adds no inference channel — a team-tier
//     caller on a private one gets the same three bytes as on a path that never
//     existed, decided several lines above any of this.
//  2. **Whether a write is encrypted is decided by the STORED OBJECT**, never by
//     the submitted content. A client that read plaintext and echoed it back
//     must not be able to store it in the clear, and one that read an envelope
//     it could not open must not be able to store that as the note's new text.
//  3. **A key we do not have is a locked note, never a missing one.** The
//     refusal says what it is and what to do, because the caller has already
//     passed the visibility check and there is nothing left to conceal.

/**
 * What this request can decrypt with, or `null`.
 *
 * The key rides the binding response and lands non-enumerable on the store. It
 * is absent for every context that has never encrypted a note, and absent again
 * for one whose key the control plane could not open; all of those are the same
 * answer here, which is that this request cannot decrypt.
 *
 * A `keys` map rather than one key, because that is the shape rotation needs: a
 * deployment mid-rotation opens notes written under either generation without
 * any caller knowing which.
 */
function encryptionContext(store) {
  const key = store?.encryptionKey;
  const workspaceId = store?.actor?.workspaceId;
  if (!key || typeof workspaceId !== "string" || !workspaceId) return null;
  return {
    workspaceId,
    // The generation a fresh encryption writes under, and the material that
    // opens it — `sealNoteContent`'s pair.
    generation: key.current,
    dataKey: key.keys[key.current],
    // Every live generation, current and retired alike — what `decryptNote`
    // needs to open a note regardless of which one wrapped it, and mid-rotation
    // that is more than one.
    keys: key.keys,
  };
}

/**
 * The refusal an encrypted note gets when this request holds no key for it.
 *
 * Deliberately explicit, where every other refusal in this gateway is uniform.
 * Reaching this line required passing `canSee`, so the caller already knows the
 * note is there — "not found" would send somebody hunting for a note they can
 * see sitting in their own bucket.
 */
export function encryptedNoteRefusal(path) {
  return toolError(
    `that note is encrypted and this connection cannot open it: ${path}. ` +
      "Its content is stored as ciphertext.",
  );
}

/**
 * Read a stored note as plaintext, whether or not it was encrypted.
 *
 * @returns {Promise<{ok: true, text: string, encrypted: boolean}|{ok: false}>}
 */
export async function openStoredNote(store, stored) {
  if (!isEncryptedNote(stored)) return { ok: true, text: stored, encrypted: false };
  const context = encryptionContext(store);
  if (context === null) return { ok: false };
  try {
    return { ok: true, text: await decryptNote(stored, context), encrypted: true };
  } catch (error) {
    // A `NoteCryptoError` is a note this deployment cannot open: a generation
    // it holds no key for, a tampered envelope, an envelope carried in from
    // another context. Every one of them is "locked", and none may be answered
    // by handing the caller the ciphertext instead. Anything else is a bug and
    // rethrows.
    if (error instanceof NoteCryptoError) return { ok: false };
    throw error;
  }
}

/**
 * `generatedNoteBytes` bound to this request's key, for the generators below.
 *
 * The rule and everything it costs live in `src/encryption.js`; this is the
 * half that needs a workspace and a key, which that module deliberately knows
 * nothing about. `null` back means *leave the note alone*.
 */
export async function generatedNoteFor(store, text, storedText) {
  return await generatedNoteBytes(text, storedText, (plaintext) =>
    sealNoteContent(store, plaintext, storedText),
  );
}

/**
 * Store a generated note without orphaning an already initialized document.
 * New paths and ineligible/encrypted notes retain their legacy write path;
 * existing eligible plaintext notes use the collaboration CAS instead.
 */
export async function generatedCollaborationBase(store, path, previousText) {
  if (typeof previousText === "string" && collaborationSupported(store) &&
      collaborationEligible(path, previousText)) {
    return readCollaborationDocument(store, path);
  }
  return null;
}

export async function writeGeneratedNote(store, path, body, collaborationBase = null) {
  if (collaborationBase) {
    return replaceCollaborationText(store, path, {
      documentId: collaborationBase.documentId,
      expectedEtag: collaborationBase.etag,
      text: body,
    });
  }
  return store.put(path, body);
}

/** The text currently stored at `key`, or `null` where there is nothing there. */
export async function storedTextAt(store, key) {
  const object = await getWithLegacyFallback(store, key);
  return object ? await object.text() : null;
}

/**
 * The bytes to store for a note whose stored form is encrypted.
 *
 * Reachable only where the stored object has already been read and found
 * encrypted, so there is no path to it with a note that was not — which is rule
 * 2 above expressed as a call graph rather than as a check somebody has to
 * remember to write.
 */
export async function sealNoteContent(store, plaintext, storedText) {
  const context = encryptionContext(store);
  if (context === null) return null;
  /*
   * A NOTE THIS REQUEST CANNOT OPEN IS A NOTE THIS REQUEST CANNOT WRITE.
   *
   * Phase 2 put a second kind of encrypted note in the bucket: one whose only
   * recipient is a passphrase, which nothing here can open, by design. Sealing
   * *that* note's replacement with the workspace key would leave a perfectly
   * valid encrypted note at the path — encrypted for us, readable by every
   * connected client, with the owner's lock gone and the ciphertext that was
   * under it destroyed. It would look like a successful write.
   *
   * So the openability of the stored object gates the write, and the answer is
   * `null`, which every caller already reads as *leave the note alone*. This is
   * the same rule the file's header states, taken one step further than Phase 1
   * needed: whether a write is encrypted is decided by the stored object, and
   * whether it may happen at all is decided by the same place.
   */
  if (typeof storedText === "string" && isEncryptedNote(storedText)) {
    const opened = await openStoredNote(store, storedText);
    if (!opened.ok) return null;
  }
  return await encryptNote(plaintext, {
    workspaceId: context.workspaceId,
    workspaceKey: context.dataKey,
    keyId: context.generation,
  });
}
