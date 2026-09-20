/**
 * The envelope, in the console.
 *
 * ONE FORMAT, TWO RUNTIMES, ONE CORPUS — the shape this repository already uses
 * for `canSee` (`privacyEngine.test.ts`) and for the encrypted-note marker
 * (`noteEncryptionParity.test.ts`). `apps/mcp/src/encryption.js` is the
 * normative spec and the offline decryptor; this is the copy the console runs,
 * and `__tests__/passphraseEnvelope.test.ts` runs both over one corpus and
 * asserts identical bytes and mutual round trips. A port with no parity test is
 * a second opinion waiting to disagree, and here a disagreement is somebody's
 * note that opens in one place and not the other.
 *
 * ## Why a port at all
 *
 * Because a passphrase note is encrypted and decrypted **on the device**, and
 * the device is running this bundle. The gateway module cannot be imported
 * here: `apps/mcp` is a Cloudflare Worker with no package boundary Metro can
 * follow, and making one would put the gateway's source inside the app's
 * dependency graph to save 200 lines. What is not duplicated is the crypto:
 * both files are Web Crypto and nothing else.
 *
 * ## What it deliberately does not do
 *
 * No workspace recipient, ever. This console has no workspace data key and must
 * never be given one — the key that opens the at-rest mode belongs to the
 * gateway. So the only envelope this file writes is a passphrase-only one, and
 * the only recipient it touches is a passphrase.
 */

import { fromBase64Url, toBase64Url, type KdfDescriptor } from "./kdf.ts";
import {
  hasNativeNoteCrypto,
  nativeAesGcmDecrypt,
  nativeAesGcmEncrypt,
  nativeRandomBytes,
} from "./nativeCrypto";

export const ENVELOPE_VERSION = 1;
export const CONTENT_ALG = "A256GCM";
export const MARKER_KEY = "context_encryption";
export const KEY_MARKER_KEY = "context_encryption_key";
export const FENCE_LANGUAGE = "context-encrypted";
export const RECIPIENT_PASSPHRASE = "passphrase";
export const RECIPIENT_WORKSPACE = "workspace";

const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface Recipient {
  kind: string;
  id: string;
  alg: string;
  iv: string;
  wrapped: string;
  kdf?: KdfDescriptor;
}

export interface Envelope {
  v: number;
  alg: string;
  iv: string;
  ct: string;
  aad: string;
  recipients: Recipient[];
}

/** Every failure in this file. Never carries key material, plaintext or ciphertext. */
export class NoteCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteCryptoError";
  }
}

function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The marker, and only the marker — cheap, total, and never throwing.
 *
 * A BOM is tolerated because editors add one and Obsidian parses through it; a
 * leading newline is not, because frontmatter that does not start at the first
 * byte is not frontmatter to anything else either. Both halves match the
 * gateway's copy exactly, and the parity test is what keeps them matching.
 */
export function isEncryptedNote(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const body = withoutBom(text);
  if (!body.startsWith("---")) return false;
  const end = body.indexOf("\n---", 3);
  if (end < 0) return false;
  return new RegExp(`^\\s*${MARKER_KEY}\\s*:\\s*v?\\d+\\s*$`, "m").test(body.slice(3, end));
}

/** The bytes an encrypted note is, given its envelope. Byte-identical to the gateway's. */
export function renderEncryptedNote(envelope: Envelope): string {
  const generation = (envelope.recipients ?? []).find(
    (recipient) =>
      recipient &&
      recipient.kind === RECIPIENT_WORKSPACE &&
      typeof recipient.id === "string" &&
      /^[A-Za-z0-9_-]{1,32}$/.test(recipient.id),
  )?.id;
  return [
    "---",
    `${MARKER_KEY}: v${ENVELOPE_VERSION}`,
    ...(generation === undefined ? [] : [`${KEY_MARKER_KEY}: ws:${generation}`]),
    "---",
    "",
    "> [!NOTE] This note is encrypted.",
    "> Its content is stored as ciphertext and cannot be read here. Open it in",
    "> Context, or decrypt it yourself with the spec in",
    "> docs/decisions/encryption.md.",
    "",
    "```" + FENCE_LANGUAGE,
    JSON.stringify(envelope),
    "```",
    "",
  ].join("\n");
}

/**
 * The envelope inside an encrypted note, `null` for an ordinary one, and a
 * throw for a note that claims to be encrypted and is not readable as one.
 *
 * That asymmetry is the same one the gateway's copy makes and it is the only
 * thing standing between a broken envelope and a caller serving it as plaintext
 * or overwriting it as though it were one.
 */
export function parseEncryptedNote(text: string): Envelope | null {
  if (!isEncryptedNote(text)) return null;
  const body = withoutBom(text);
  const fence = "```" + FENCE_LANGUAGE;
  const start = body.indexOf(fence);
  if (start < 0) throw new NoteCryptoError("encrypted note has no envelope block");
  const bodyStart = body.indexOf("\n", start);
  if (bodyStart < 0) throw new NoteCryptoError("encrypted note has no envelope block");
  const end = body.indexOf("\n```", bodyStart);
  if (end < 0) throw new NoteCryptoError("encrypted note has an unterminated envelope block");
  let envelope: unknown;
  try {
    envelope = JSON.parse(body.slice(bodyStart + 1, end));
  } catch {
    throw new NoteCryptoError("encrypted note has a malformed envelope");
  }
  return assertEnvelopeShape(envelope);
}

function assertEnvelopeShape(value: unknown): Envelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NoteCryptoError("encrypted note has a malformed envelope");
  }
  const envelope = value as Envelope;
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new NoteCryptoError("this note was written by a newer version of Context");
  }
  if (envelope.alg !== CONTENT_ALG) throw new NoteCryptoError("unsupported envelope algorithm");
  if (typeof envelope.aad !== "string" || envelope.aad.length === 0) {
    throw new NoteCryptoError("envelope is missing its associated data");
  }
  if (typeof envelope.iv !== "string" || typeof envelope.ct !== "string") {
    throw new NoteCryptoError("envelope is missing its ciphertext");
  }
  if (!Array.isArray(envelope.recipients) || envelope.recipients.length === 0) {
    throw new NoteCryptoError("envelope has no recipients");
  }
  for (const recipient of envelope.recipients) {
    if (!recipient || typeof recipient !== "object" || Array.isArray(recipient)) {
      throw new NoteCryptoError("envelope has a malformed recipient");
    }
    if (typeof recipient.kind !== "string" || typeof recipient.id !== "string") {
      throw new NoteCryptoError("envelope has a malformed recipient");
    }
    if (recipient.alg !== CONTENT_ALG) {
      throw new NoteCryptoError("envelope has a recipient with an unsupported algorithm");
    }
    if (typeof recipient.iv !== "string" || typeof recipient.wrapped !== "string") {
      throw new NoteCryptoError("envelope has a malformed recipient");
    }
    if (recipient.kind === RECIPIENT_PASSPHRASE) assertKdfDescriptor(recipient.kdf);
  }
  return envelope;
}

/**
 * Bounds on a KDF descriptor read out of a bucket, checked before anything acts
 * on it — the same limits the gateway enforces, for the reason the gateway
 * states: a file in somebody's bucket does not get to decide how much memory
 * this device is about to spend on every unlock attempt.
 */
export function assertKdfDescriptor(kdf: KdfDescriptor | undefined): KdfDescriptor {
  if (!kdf || typeof kdf !== "object") {
    throw new NoteCryptoError("a passphrase recipient must name its KDF");
  }
  const bounded = (value: unknown, min: number, max: number) =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
  if (typeof kdf.id !== "string") throw new NoteCryptoError("a passphrase recipient must name its KDF");
  if (kdf.v !== 0x13) throw new NoteCryptoError("unsupported argon2 version");
  if (!bounded(kdf.m, 8, 2 * 1024 * 1024)) throw new NoteCryptoError("KDF memory out of range");
  if (!bounded(kdf.t, 1, 16)) throw new NoteCryptoError("KDF iterations out of range");
  if (!bounded(kdf.p, 1, 16)) throw new NoteCryptoError("KDF parallelism out of range");
  if (kdf.m < 8 * kdf.p) throw new NoteCryptoError("KDF memory is below argon2's own floor");
  if (typeof kdf.salt !== "string") throw new NoteCryptoError("a passphrase recipient must carry a salt");
  const salt = fromBase64Url(kdf.salt);
  if (salt.byteLength < 8 || salt.byteLength > 64) {
    throw new NoteCryptoError("KDF salt is the wrong length");
  }
  return kdf;
}

export function contentAad(workspaceId: string): string {
  if (!workspaceId) throw new NoteCryptoError("an encrypted note must be bound to a workspace id");
  return `context-note-v1:${workspaceId}`;
}

export function wrapAad(workspaceId: string): string {
  if (!workspaceId) throw new NoteCryptoError("an encrypted note must be bound to a workspace id");
  return `context-note-key-v1:${workspaceId}`;
}

function subtle(): SubtleCrypto {
  const source = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!source) throw new NoteCryptoError("this runtime cannot open encrypted notes");
  return source;
}

async function aesKey(bytes: Uint8Array): Promise<CryptoKey> {
  if (bytes.byteLength !== KEY_BYTES) throw new NoteCryptoError("a key must be 32 bytes");
  return await subtle().importKey("raw", buf(bytes), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const source = (globalThis as { crypto?: Crypto }).crypto;
  if (!source?.getRandomValues) {
    const native = nativeRandomBytes(length);
    if (native !== null) return native;
    throw new NoteCryptoError("no cryptographic random source");
  }
  source.getRandomValues(bytes);
  return bytes;
}

/**
 * Encoding, per call rather than once at import.
 *
 * A module-level `new TextEncoder()` throws at *import* time in a runtime that
 * has not got one, which turns "this device cannot open locked notes" into
 * "this screen does not render" for every caller that merely imports a
 * constant from here. The capability check in `kdf.ts` is where that answer
 * belongs; a construction cost of nothing is what it costs to keep it there.
 */
const encode = (text: string): BufferSource => buf(new TextEncoder().encode(text));

/**
 * A view widened to `BufferSource`.
 *
 * `Uint8Array<ArrayBufferLike>` and `BufferSource` are the same bytes and
 * different types under this TypeScript version, and Web Crypto's parameter
 * objects want the second. One named helper beats a cast at each of the eight
 * call sites, where a cast is one more thing to read past.
 */
const buf = (bytes: Uint8Array): BufferSource => bytes as unknown as BufferSource;

async function encryptBytes(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, aad: string): Promise<Uint8Array> {
  if (hasNativeNoteCrypto()) {
    return await nativeAesGcmEncrypt({ key, iv, plaintext, aad: new TextEncoder().encode(aad) });
  }
  return new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: buf(iv), additionalData: encode(aad) },
      await aesKey(key),
      buf(plaintext),
    ),
  );
}

async function decryptBytes(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array, aad: string): Promise<Uint8Array> {
  if (hasNativeNoteCrypto()) {
    return await nativeAesGcmDecrypt({ key, iv, ciphertext, aad: new TextEncoder().encode(aad) });
  }
  return new Uint8Array(
    await subtle().decrypt(
      { name: "AES-GCM", iv: buf(iv), additionalData: encode(aad) },
      await aesKey(key),
      buf(ciphertext),
    ),
  );
}

/** Encrypt a whole note so that only this passphrase-derived key opens it. */
export async function encryptForPassphrase(
  plaintext: string,
  options: { workspaceId: string; kek: Uint8Array; kdf: KdfDescriptor; id?: string },
): Promise<string> {
  const aad = contentAad(options.workspaceId);
  const noteKey = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const plaintextBytes = new TextEncoder().encode(plaintext);
  try {
    const ct = await encryptBytes(noteKey, iv, plaintextBytes, aad);
    const recipient = await wrapNoteKey(noteKey, options);
    return renderEncryptedNote({
      v: ENVELOPE_VERSION,
      alg: CONTENT_ALG,
      iv: toBase64Url(iv),
      ct: toBase64Url(ct),
      aad,
      recipients: [recipient],
    });
  } finally {
    noteKey.fill(0);
    plaintextBytes.fill(0);
  }
}

/** Wrap a note key for a passphrase-derived key, carrying the KDF that made it. */
export async function wrapNoteKey(
  noteKey: Uint8Array,
  options: { workspaceId: string; kek: Uint8Array; kdf: KdfDescriptor; id?: string },
): Promise<Recipient> {
  const kdf = assertKdfDescriptor(options.kdf);
  const iv = randomBytes(IV_BYTES);
  const wrapped = await encryptBytes(options.kek, iv, noteKey, wrapAad(options.workspaceId));
  return {
    kind: RECIPIENT_PASSPHRASE,
    id: options.id ?? "p1",
    alg: CONTENT_ALG,
    iv: toBase64Url(iv),
    wrapped: toBase64Url(wrapped),
    kdf: { id: kdf.id, v: kdf.v, m: kdf.m, t: kdf.t, p: kdf.p, salt: kdf.salt },
  };
}

/**
 * The note key out of one recipient.
 *
 * **One failure, whatever went wrong.** A wrong passphrase, a corrupted wrap and
 * a note carried in from another context all produce the same error with the
 * same message, because telling them apart is an oracle that says "keep
 * guessing, you have the right file".
 */
export async function unwrapNoteKey(
  recipient: Recipient,
  kek: Uint8Array,
  workspaceId: string,
): Promise<Uint8Array> {
  let noteKey: Uint8Array;
  try {
    noteKey = await decryptBytes(
      kek,
      assertIv(fromBase64Url(recipient.iv)),
      fromBase64Url(recipient.wrapped),
      wrapAad(workspaceId),
    );
  } catch (error) {
    if (error instanceof NoteCryptoError && error.message.includes("runtime")) throw error;
    throw new NoteCryptoError("that passphrase did not open this note");
  }
  if (noteKey.byteLength !== KEY_BYTES) {
    noteKey.fill(0);
    throw new NoteCryptoError("that passphrase did not open this note");
  }
  return noteKey;
}

/** Open a passphrase note back to its plaintext. */
export async function decryptWithPassphrase(
  stored: string,
  options: { workspaceId: string; kek: Uint8Array; id?: string },
): Promise<string> {
  const envelope = parseEncryptedNote(stored);
  if (envelope === null) throw new NoteCryptoError("that note is not encrypted");
  if (envelope.aad !== contentAad(options.workspaceId)) {
    throw new NoteCryptoError("that passphrase did not open this note");
  }
  const recipient = envelope.recipients.find(
    (candidate) =>
      candidate.kind === RECIPIENT_PASSPHRASE &&
      (options.id === undefined || candidate.id === options.id),
  );
  if (recipient === undefined) {
    throw new NoteCryptoError("this note is not protected by a passphrase");
  }
  const noteKey = await unwrapNoteKey(recipient, options.kek, options.workspaceId);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await decryptBytes(
      noteKey,
      assertIv(fromBase64Url(envelope.iv)),
      fromBase64Url(envelope.ct),
      envelope.aad,
    );
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    if (error instanceof NoteCryptoError) throw error;
    throw new NoteCryptoError("this note's contents could not be read");
  } finally {
    noteKey.fill(0);
    plaintext?.fill(0);
  }
}

/**
 * One recipient replaced by another of the same name — a passphrase change.
 *
 * The body is untouched, which is the whole reason the note key is wrapped
 * rather than derived: changing a passphrase is one small write and cannot
 * half-finish into a note nobody can open.
 */
export function replacingRecipient(stored: string, recipient: Recipient): string {
  const envelope = parseEncryptedNote(stored);
  if (envelope === null) throw new NoteCryptoError("that note is not encrypted");
  assertEnvelopeShape({ ...envelope, recipients: [recipient] });
  let replaced = false;
  const recipients = envelope.recipients.map((existing) => {
    if (existing.kind !== recipient.kind || existing.id !== recipient.id) return existing;
    replaced = true;
    return recipient;
  });
  if (!replaced) throw new NoteCryptoError("that note carries no such recipient");
  return renderEncryptedNote({ ...envelope, recipients });
}

/** Is this note locked behind a passphrase — as opposed to encrypted at rest? */
export function isPassphraseNote(text: string): boolean {
  if (!isEncryptedNote(text)) return false;
  try {
    return parseEncryptedNote(text)!.recipients.some(
      (recipient) => recipient.kind === RECIPIENT_PASSPHRASE,
    );
  } catch {
    // A broken envelope is not a passphrase note and is not an ordinary one
    // either. Answering `false` here sends it down the read-only path that
    // shows it as a locked note and refuses to overwrite it, which is the safe
    // direction for bytes nothing can parse.
    return false;
  }
}

/** The KDF descriptor a locked note names, so the unlock screen can derive. */
export function passphraseKdfOf(text: string): KdfDescriptor | null {
  const envelope = parseEncryptedNote(text);
  if (envelope === null) return null;
  const recipient = envelope.recipients.find((r) => r.kind === RECIPIENT_PASSPHRASE);
  return recipient?.kdf ?? null;
}

function assertIv(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength !== IV_BYTES) throw new NoteCryptoError("envelope has a malformed IV");
  return bytes;
}
