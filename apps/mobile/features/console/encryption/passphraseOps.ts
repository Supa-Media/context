/**
 * The four things somebody does with a passphrase, and the one thing none of
 * them may do.
 *
 * Protect a note, unlock one, change the passphrase, take it off. Every one of
 * them runs **entirely on the device**: the passphrase is turned into a key
 * here, the note is encrypted or decrypted here, and what leaves is ciphertext
 * — the same bytes the bucket already holds for every other encrypted note.
 *
 * ## The writer is a parameter, and that is the point
 *
 * These functions never call anything themselves. They are handed a `NoteWriter`
 * — in the app, the console's ordinary conditional bucket write — and everything
 * they send goes through it. So "the passphrase never reaches a server" stops
 * being a claim about a call graph somebody has to read, and becomes a test:
 * `__tests__/passphraseOps.test.ts` passes in a writer that records every
 * request and asserts that no request body, path or header anywhere in an
 * add / unlock / change cycle contains the passphrase, the derived key, or the
 * note's plaintext.
 *
 * `derive` is injectable for the same reason plus one more: Argon2id at the
 * shipped parameters is about a second of arithmetic, and a suite that paid it
 * on every case would be a suite people skip.
 */

import {
  NoteCryptoError,
  decryptWithPassphrase,
  encryptForPassphrase,
  isPassphraseNote,
  parseEncryptedNote,
  passphraseKdfOf,
  replacingRecipient,
  unwrapNoteKey,
  wrapNoteKey,
} from "./envelope.ts";
import {
  derivePassphraseKey,
  newKdfDescriptor,
  type KdfDescriptor,
} from "./kdf.ts";

/** What the console already has for writing a note; nothing new is needed. */
export interface NoteWriter {
  write(request: {
    path: string;
    content: string;
    expectedEtag: string | null;
  }): Promise<{ etag: string }>;
}

/** Every operation takes this; nothing here reads a global. */
export interface OpsContext {
  workspaceId: string;
  writer: NoteWriter;
  /** Injected so tests need not pay a real derivation. Defaults to Argon2id. */
  derive?: (passphrase: string, kdf: KdfDescriptor) => Uint8Array | Promise<Uint8Array>;
}

async function deriveWith(context: OpsContext, passphrase: string, kdf: KdfDescriptor): Promise<Uint8Array> {
  return await (context.derive ?? derivePassphraseKey)(passphrase, kdf);
}

/**
 * Lock a note behind a passphrase for the first time.
 *
 * The note's current plaintext goes in and ciphertext comes out. There is no
 * `workspace` recipient in the result and there is no way to ask for one: a
 * passphrase note is not readable by us, which is the whole product, and
 * `docs/decisions/encryption.md` states what it costs — no AI client can read
 * it either.
 *
 * The `expectedEtag` is passed straight through, so this is exactly as
 * conflict-safe as an ordinary save. Losing a concurrent edit here would lose
 * it into a note nobody can diff.
 */
export async function protectNote(
  input: { path: string; plaintext: string; etag: string | null; passphrase: string },
  context: OpsContext,
): Promise<{ etag: string; key: Uint8Array; stored: string }> {
  requirePassphrase(input.passphrase);
  const kdf = newKdfDescriptor();
  const key = await deriveWith(context, input.passphrase, kdf);
  const document = await encryptForPassphrase(input.plaintext, {
    workspaceId: context.workspaceId,
    kek: key,
    kdf,
  });
  const { etag } = await context.writer.write({
    path: input.path,
    content: document,
    expectedEtag: input.etag,
  });
  // `stored` is what a caller needs to keep locally in step with the bucket
  // without a second read: the next operation on this note (a save, a
  // passphrase change) reads its KDF descriptor and its recipient straight out
  // of it, via `passphraseKdfOf`/`parseEncryptedNote`.
  return { etag, key, stored: document };
}

/**
 * Open a locked note.
 *
 * **No request is made.** The console already has the note's bytes — a locked
 * note is delivered like any other, because its ciphertext is its content — so
 * unlocking is arithmetic and nothing else. That is the strongest form the
 * promise can take: there is no call to inspect, because there is no call.
 */
export async function unlockNote(
  input: { stored: string; passphrase: string },
  context: OpsContext,
): Promise<{ key: Uint8Array; plaintext: string }> {
  requirePassphrase(input.passphrase);
  const kdf = passphraseKdfOf(input.stored);
  if (kdf === null) throw new NoteCryptoError("this note is not protected by a passphrase");
  const key = await deriveWith(context, input.passphrase, kdf);
  // One failure for a wrong passphrase, a corrupted envelope and a note carried
  // in from another context, decided inside `envelope.ts`. Catching and
  // relabelling here would rebuild the oracle that file exists to avoid.
  const plaintext = await decryptWithPassphrase(input.stored, {
    workspaceId: context.workspaceId,
    kek: key,
  });
  return { key, plaintext };
}

/**
 * Save an edit to a note that is unlocked in this session.
 *
 * A fresh note key and a fresh IV, wrapped under the **same** derived key with
 * the **same** KDF descriptor — same salt, same parameters — so the passphrase
 * that opened this note still opens the version that replaces it. Rotating the
 * salt here would silently invalidate the key the session is holding and the
 * next save would fail with what looks like a wrong passphrase.
 */
export async function saveUnlockedNote(
  input: { path: string; plaintext: string; etag: string | null; key: Uint8Array; stored: string },
  context: OpsContext,
): Promise<{ etag: string; stored: string }> {
  const kdf = passphraseKdfOf(input.stored);
  if (kdf === null) throw new NoteCryptoError("this note is not protected by a passphrase");
  const document = await encryptForPassphrase(input.plaintext, {
    workspaceId: context.workspaceId,
    kek: input.key,
    kdf,
  });
  const { etag } = await context.writer.write({
    path: input.path,
    content: document,
    expectedEtag: input.etag,
  });
  return { etag, stored: document };
}

/**
 * Change the passphrase without rewriting the note.
 *
 * The note key comes out of the envelope under the old key and goes back in
 * under the new one; `ct`, `iv` and `aad` are the bytes they were. This is what
 * the wrapped note key was bought for, and it is why a passphrase change is one
 * small write rather than a re-encryption that could half-finish.
 *
 * It takes the **old passphrase**, not the session's key, on purpose: somebody
 * who walked away from an unlocked laptop should not be able to change the
 * passphrase without knowing the current one.
 */
export async function changePassphrase(
  input: {
    path: string;
    stored: string;
    etag: string | null;
    currentPassphrase: string;
    newPassphrase: string;
  },
  context: OpsContext,
): Promise<{ etag: string; key: Uint8Array; stored: string }> {
  requirePassphrase(input.newPassphrase);
  const envelope = parseEncryptedNote(input.stored);
  if (envelope === null || !isPassphraseNote(input.stored)) {
    throw new NoteCryptoError("this note is not protected by a passphrase");
  }
  const currentKdf = passphraseKdfOf(input.stored)!;
  const currentKey = await deriveWith(context, input.currentPassphrase, currentKdf);
  const recipient = envelope.recipients.find((candidate) => candidate.kind === "passphrase")!;
  const noteKey = await unwrapNoteKey(recipient, currentKey, context.workspaceId);

  // A fresh salt for the new passphrase, so the new key is not related to the
  // old one by anything but the person who chose them both.
  const nextKdf = newKdfDescriptor();
  const nextKey = await deriveWith(context, input.newPassphrase, nextKdf);
  const rewrapped = await wrapNoteKey(noteKey, {
    workspaceId: context.workspaceId,
    kek: nextKey,
    kdf: nextKdf,
    id: recipient.id,
  });
  noteKey.fill(0);
  currentKey.fill(0);

  const document = replacingRecipient(input.stored, rewrapped);
  const { etag } = await context.writer.write({
    path: input.path,
    content: document,
    expectedEtag: input.etag,
  });
  return { etag, key: nextKey, stored: document };
}

/**
 * Take the passphrase off a note, leaving ordinary Markdown.
 *
 * Requires the passphrase rather than the session key, for the same reason a
 * change does — and because this one is the irreversible direction in the
 * *other* sense: it publishes the note's content back into the bucket in the
 * clear, where the storage provider and every connected client can read it
 * again. The console asks for that in words before calling this.
 */
export async function removePassphrase(
  input: { path: string; stored: string; etag: string | null; passphrase: string },
  context: OpsContext,
): Promise<{ etag: string; plaintext: string }> {
  const { plaintext } = await unlockNote(
    { stored: input.stored, passphrase: input.passphrase },
    context,
  );
  const { etag } = await context.writer.write({
    path: input.path,
    content: plaintext,
    expectedEtag: input.etag,
  });
  return { etag, plaintext };
}

/**
 * The floor on a passphrase, and it is a floor rather than a policy.
 *
 * Argon2id at OWASP's minimum parameters is what stands between an offline
 * attacker and a short passphrase, and the decision file is explicit that the
 * parameters this console can afford in JavaScript are lower than the ones a
 * native implementation would use. Length is what makes up the difference, so
 * the number is here rather than in a validator somebody can skip: twelve
 * characters is the floor, and the acknowledgement screen asks for a
 * passphrase rather than a password in the words it uses.
 */
export const MINIMUM_PASSPHRASE_LENGTH = 12;

function requirePassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || passphrase.length < MINIMUM_PASSPHRASE_LENGTH) {
    throw new NoteCryptoError(
      `a passphrase must be at least ${MINIMUM_PASSPHRASE_LENGTH} characters — ` +
        "several words you will remember beat a short password you will not",
    );
  }
}
