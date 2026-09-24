/**
 * The on-bucket format: rendering an envelope into a note, recognising one by
 * its marker, and parsing and validating it before any byte reaches Web
 * Crypto. See `../encryption.js` for the failure directions this keeps.
 */

import {
  CONTENT_ALG,
  ENVELOPE_VERSION,
  FENCE_LANGUAGE,
  KDF_ARGON2ID,
  KDF_LIMITS,
  KEY_ID_PATTERN,
  KEY_MARKER_KEY,
  MARKER_KEY,
  NoteCryptoError,
  RECIPIENT_PASSPHRASE,
  RECIPIENT_WORKSPACE,
  describeField,
  fromBase64Url,
} from "./primitives.js";

/* -------------------------------- format --------------------------------- */

/**
 * The document an envelope becomes.
 *
 * Deliberately hand-assembled rather than templated through a YAML or Markdown
 * library: this is a stable on-bucket format, so its exact bytes are part of
 * the contract, and it must be producible by a reimplementation with nothing
 * but string concatenation.
 */
export function renderEncryptedNote(envelope) {
  // The generation named in the frontmatter is the *workspace* recipient's, and
  // it is omitted rather than invented when there is not one to name. A
  // `ws:undefined` line would be read back by `encryptedNoteKeyId` as a real
  // generation, and a re-wrap pass would then look for a key called
  // "undefined" instead of reporting a note it cannot place.
  const generation = (envelope.recipients ?? []).find(
    (recipient) =>
      recipient &&
      recipient.kind === RECIPIENT_WORKSPACE &&
      typeof recipient.id === "string" &&
      KEY_ID_PATTERN.test(recipient.id),
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
 * The marker, and only the marker.
 *
 * Cheap, total, and never throws — every caller that must *avoid* an encrypted
 * note rather than read one asks this, and a broken envelope must be avoided
 * exactly as hard as a good one.
 */
export function isEncryptedNote(text) {
  const body = withoutBom(text);
  if (body === null || !body.startsWith("---")) return false;
  const end = body.indexOf("\n---", 3);
  if (end < 0) return false;
  return new RegExp(`^\\s*${MARKER_KEY}\\s*:\\s*v?\\d+\\s*$`, "m").test(
    body.slice(3, end),
  );
}

/**
 * The text with a leading byte-order mark removed, or `null` if it is not text.
 *
 * A BOM is the one thing that can sit in front of `---` and still be
 * frontmatter to every tool that reads it: editors on Windows add one on save,
 * Obsidian parses through it, and YAML's own spec allows it. Without this a
 * BOM'd envelope answers `false` here — and then the write path stores
 * plaintext over it and the link rewriter runs a regex through it, which is
 * this feature's one unrecoverable failure arriving from a text editor.
 *
 * A leading *newline* is deliberately not tolerated: frontmatter that does not
 * start at the first byte is not frontmatter, to Obsidian or to anything else,
 * and treating it as such would start recognising markers in the middle of
 * ordinary notes.
 */
function withoutBom(text) {
  if (typeof text !== "string") return null;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * What an indexer may copy out of a note.
 *
 * `""` for an encrypted note, its own text for every other. Both index paths —
 * the R2 shard index inside the customer's own bucket, and the D1 projection in
 * a database we own — call this instead of reading a body directly, so
 * "no plaintext and no ciphertext of an encrypted note is ever indexed" is one
 * function rather than two checks that can drift apart.
 *
 * **Empty rather than skipped**, and the reason is arithmetic rather than
 * taste. A note the projection never writes a row for is a note
 * `countProjected` never counts, so `notesPending` never reaches zero, so the
 * control plane never marks the index `ready` — one encrypted note would turn
 * fast search off for the whole context, permanently and invisibly. An empty
 * row keeps the diff converging and the census honest while carrying nothing
 * of the note but its path, which every other row in the same projection
 * already carries and which `list_notes` will hand the same caller anyway.
 *
 * What it costs, and it is the cost `docs/decisions/encryption.md` names:
 * **search does not find encrypted notes.** The opt-in that would change that
 * is graded there and is deliberately not built.
 *
 * Checked on the marker rather than on a successful parse, so a *broken*
 * envelope is excluded exactly as hard as a good one.
 */
export function indexableText(text) {
  return isEncryptedNote(text) ? "" : text;
}

/**
 * The bytes to store for a note this gateway *generated*, given whatever is
 * already at that path.
 *
 * "Whether a write is encrypted is decided by the stored object at that path,
 * never by the submitted content" is a rule about every writer, not only about
 * the one a person drives. Several paths regenerate a note at a fixed key — an
 * inbox capture replayed under the same external id, a meeting note, a calendar
 * refresh — and each legitimately replaces the note's **content**. None of them
 * is a reason to also replace its **form**: a note somebody deliberately
 * encrypted must not quietly become plaintext because a scheduled job rewrote
 * it.
 *
 * Three answers, and the third is why this returns a value rather than bytes:
 *
 *  - nothing there, or plaintext there — the text, unchanged;
 *  - an envelope there, and a key — the text, encrypted;
 *  - an envelope there and **no key** — `null`, meaning *leave the note alone*.
 *    Writing plaintext over an envelope nobody in this request can open is the
 *    one outcome worse than dropping the update, because the update can be made
 *    again and the note's form cannot.
 *
 * `seal` is supplied by the caller rather than taken here, because sealing
 * needs a workspace and a key and this module deliberately knows about neither.
 * It answers `null` where the caller holds no key.
 *
 * Decided on the marker rather than on a successful parse, so a broken envelope
 * is protected exactly as hard as a good one.
 *
 * @param {string} text the note as the generator produced it
 * @param {string|null} storedText what is at the path now, or `null`
 * @param {(plaintext: string) => Promise<string|null>} seal
 * @returns {Promise<string|null>}
 */
export async function generatedNoteBytes(text, storedText, seal) {
  if (typeof storedText !== "string" || !isEncryptedNote(storedText)) return text;
  return await seal(text);
}

/**
 * The key generation an encrypted note names, without opening it.
 *
 * A re-wrap pass reads this to find what is still on the outgoing generation.
 * It parses only; a well-formed marker proves nothing about the ciphertext.
 * `null` where the note is not encrypted or does not name one.
 */
export function encryptedNoteKeyId(text) {
  if (!isEncryptedNote(text)) return null;
  const body = withoutBom(text);
  const end = body.indexOf("\n---", 3);
  const match = body
    .slice(3, end)
    .match(new RegExp(`^\\s*${KEY_MARKER_KEY}\\s*:\\s*ws:([A-Za-z0-9_-]{1,32})\\s*$`, "m"));
  return match ? match[1] : null;
}

/**
 * The envelope inside an encrypted note, or `null` if it is an ordinary one.
 *
 * Throws for a note that claims to be encrypted and is not readable as one.
 * See this file's header for why those two answers are different.
 */
export function parseEncryptedNote(text) {
  if (!isEncryptedNote(text)) return null;
  // The same normalization the predicate made, so the offsets below are
  // offsets into the same string it answered about.
  text = withoutBom(text);

  const fence = "```" + FENCE_LANGUAGE;
  const start = text.indexOf(fence);
  if (start < 0) throw new NoteCryptoError("encrypted note has no envelope block");
  const bodyStart = text.indexOf("\n", start);
  if (bodyStart < 0) throw new NoteCryptoError("encrypted note has no envelope block");
  const end = text.indexOf("\n```", bodyStart);
  if (end < 0) throw new NoteCryptoError("encrypted note has an unterminated envelope block");

  let envelope;
  try {
    envelope = JSON.parse(text.slice(bodyStart + 1, end));
  } catch {
    throw new NoteCryptoError("encrypted note has a malformed envelope");
  }
  return assertEnvelopeShape(envelope);
}

/**
 * Structural validation, before a single byte is handed to Web Crypto.
 *
 * Every field is read off a fixed, literal property name and every parsed
 * string lands as a value rather than as a key — the same rule the search
 * indexer's header states, for the same reason: `__proto__` arriving from a
 * customer's bucket as an object key is prototype pollution waiting for
 * whoever reads that object next.
 */
export function assertEnvelopeShape(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new NoteCryptoError("encrypted note has a malformed envelope");
  }
  if (envelope.v !== ENVELOPE_VERSION) {
    // Refused rather than best-guessed. A newer gateway may write a v2; an
    // older one must say it cannot read it, not open it as though it could.
    throw new NoteCryptoError(`unsupported envelope version ${describeField(envelope.v)}`);
  }
  if (envelope.alg !== CONTENT_ALG) {
    throw new NoteCryptoError(`unsupported envelope algorithm ${describeField(envelope.alg)}`);
  }
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
    // A recipient kind this build does not know is left alone rather than
    // refused: the array is the extension point, and an older gateway meeting a
    // newer kind must still open the note through the recipient it does know.
    // What it may not do is *use* one it cannot read, and nothing below looks
    // for a kind by anything but an exact match.
    if (recipient.kind === RECIPIENT_PASSPHRASE) assertKdfDescriptor(recipient.kdf);
  }
  return envelope;
}

/**
 * The KDF a passphrase recipient names, checked before anything acts on it.
 *
 * Exported because the client that derives the key runs this same check on the
 * same object: a descriptor read out of a bucket decides how much memory and
 * how much time a device is about to spend, and the only safe place to bound
 * that is before the first allocation. See `KDF_LIMITS`.
 */
export function assertKdfDescriptor(kdf) {
  if (!kdf || typeof kdf !== "object" || Array.isArray(kdf)) {
    throw new NoteCryptoError("a passphrase recipient must name its KDF");
  }
  if (kdf.id !== KDF_ARGON2ID) {
    throw new NoteCryptoError(`unsupported passphrase KDF ${describeField(kdf.id)}`);
  }
  // Argon2's own version byte, 0x13. A different one is a different KDF with
  // the same name, and guessing between them silently produces a wrong key.
  if (kdf.v !== 0x13) {
    throw new NoteCryptoError(`unsupported argon2 version ${describeField(kdf.v)}`);
  }
  const bounded = (value, min, max) =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
  if (!bounded(kdf.m, KDF_LIMITS.minMemory, KDF_LIMITS.maxMemory)) {
    throw new NoteCryptoError(`passphrase KDF memory out of range: ${describeField(kdf.m)}`);
  }
  if (!bounded(kdf.t, 1, KDF_LIMITS.maxIterations)) {
    throw new NoteCryptoError(`passphrase KDF iterations out of range: ${describeField(kdf.t)}`);
  }
  if (!bounded(kdf.p, 1, KDF_LIMITS.maxParallelism)) {
    throw new NoteCryptoError(`passphrase KDF parallelism out of range: ${describeField(kdf.p)}`);
  }
  if (kdf.m < 8 * kdf.p) {
    throw new NoteCryptoError("passphrase KDF memory is below argon2's own floor for its lanes");
  }
  if (typeof kdf.salt !== "string") {
    throw new NoteCryptoError("a passphrase recipient must carry a salt");
  }
  const salt = fromBase64Url(kdf.salt);
  if (salt.byteLength < KDF_LIMITS.minSaltBytes || salt.byteLength > KDF_LIMITS.maxSaltBytes) {
    throw new NoteCryptoError(
      `passphrase KDF salt must be ${KDF_LIMITS.minSaltBytes}..${KDF_LIMITS.maxSaltBytes} bytes`,
    );
  }
  return kdf;
}
