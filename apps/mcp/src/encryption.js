/**
 * Per-note encryption: the envelope format, and the two pure functions that
 * write and read it.
 *
 * The design and everything it costs is `docs/decisions/encryption.md`. This
 * file is the executable half of that document's "The on-bucket format"
 * section, and it is deliberately the *whole* of it: a customer who exports
 * their workspace key and wants to read their notes without us needs this
 * module and a Web Crypto implementation, and nothing else. It therefore takes
 * no dependency on the store, the session, the control plane, or any other file
 * in this gateway — a decryptor that needs a worker to run is not an escape
 * hatch, it is the product wearing one.
 *
 * ## What an encrypted note is
 *
 * A file at its own path, unchanged. `1-projects/foo.md` stays
 * `1-projects/foo.md`: no suffix, no sidecar, no namespaced key. Its bytes are
 * valid Markdown and valid YAML, so Obsidian, a text editor and rclone all show
 * a *locked note* rather than a corrupt one — plaintext frontmatter marking it
 * encrypted, a human-readable callout saying what it is, and one fenced
 * `context-encrypted` block holding the envelope.
 *
 * The **whole** note is the plaintext, frontmatter included. The wrapper's
 * frontmatter is new and carries only the marker. Encrypting the body and
 * leaving the original frontmatter in the clear would need a rule about which
 * YAML keys are content, and `tags:` is content — the search indexer reads it,
 * so leaving it out would publish the note's subject into the index this
 * feature exists to keep it out of.
 *
 * ## The AAD binds the workspace, and deliberately not the path
 *
 * `context-note-v1:<workspaceId>` authenticates the ciphertext;
 * `context-note-key-v1:<workspaceId>` authenticates each wrapped note key. So
 * a workspace's key cannot open another workspace's note for two independent
 * reasons — the keys differ, and the AAD differs — which is what makes the
 * isolation test more than a restatement of "we used a different key".
 *
 * Binding the *path* as well is the tempting extra line and it is refused:
 * every move would become a re-encrypt, which is a full body rewrite per note
 * inside a bulk operation the Worker's subrequest budget cannot afford, and one
 * that leaves undecryptable notes behind when it stops halfway. What it would
 * buy is protection against an attacker who can *write* the customer's bucket
 * relocating a ciphertext — an attacker who could simply delete the note.
 *
 * ## Failure directions
 *
 * Two, and they point opposite ways on purpose:
 *
 *  - `parseEncryptedNote` returns `null` for a note with no marker. An ordinary
 *    note must never cost a throw.
 *  - It **throws** for a note that carries the marker and cannot be parsed.
 *    Returning `null` there would hand the caller an envelope to serve as
 *    plaintext, or to overwrite as though it were one, which is the single way
 *    this feature could silently destroy a note.
 *
 * And `isEncryptedNote` answers on the marker alone, without parsing, because
 * the callers that must not touch an encrypted body — the link rewriter, the
 * search projection — must also not touch a *broken* one.
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
const IV_BYTE_LENGTH = 12;
/** AES-256. */
const KEY_BYTE_LENGTH = 32;

/**
 * A key generation id, as it appears in `ws:<id>` in the frontmatter and in a
 * recipient's `id`. The same charset the control plane's envelope key ids use,
 * for the same reason: it is operator-chosen configuration inside a delimited
 * string, not user input, so there is no reason for it to be exotic.
 */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

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
function describeField(value) {
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

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
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
function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function keyBytesFrom(material) {
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

async function importAesKey(bytes) {
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

function requireWorkspaceId(workspaceId) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new NoteCryptoError("an encrypted note must be bound to a workspace id");
  }
  return workspaceId;
}

function requireKeyId(keyId) {
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
function assertEnvelopeShape(envelope) {
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

function assertIv(bytes) {
  if (bytes.byteLength !== IV_BYTE_LENGTH) {
    throw new NoteCryptoError("envelope has a malformed IV");
  }
  return bytes;
}

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
 * The note key bytes, from whichever workspace recipient this deployment holds
 * a key for.
 *
 * Two implementations of "which recipient opens this, and what does a failure
 * look like" would be two places for the failure to stop being uniform, so
 * `decryptNote` and everything below share this one.
 */
async function unwrapWithWorkspaceKey(envelope, { workspaceId, keys }) {
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
function workspaceRecipientFor(envelope, workspaceId, keys) {
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

/** The content half of a decrypt, once a note key is in hand. */
async function openContent(envelope, noteKeyBytes) {
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

/**
 * 32 bytes from a key-encryption key given as bytes or as base64.
 *
 * Bytes are the honest shape for something a KDF has just produced; base64 is
 * the shape it arrives in when a test pins one. Both land as the same 32 bytes
 * or neither does.
 */
function kekBytesFrom(kek) {
  if (kek instanceof Uint8Array) {
    if (kek.byteLength !== KEY_BYTE_LENGTH) {
      throw new NoteCryptoError(`a key-encryption key must be ${KEY_BYTE_LENGTH} bytes`);
    }
    return kek;
  }
  return keyBytesFrom(kek);
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

/* ----------------------------- key export --------------------------------- */

/**
 * The versioned, language-neutral bundle `export_encryption_keys` and the
 * console's export action both produce, and `packages/encryption-decryptor`
 * consumes.
 *
 * Every *live* generation is included, not only the current one — a bucket
 * can hold notes from before the workspace's most recent rotation, and an
 * export that carried only `current` would be an export that cannot open
 * them. `current` is named separately so a decryptor (or a human) knows which
 * one a freshly-encrypted note would use, but every entry here is enough, on
 * its own, to open the notes wrapped under it.
 *
 * Deliberately hand-assembled, like `renderEncryptedNote`: this is the format
 * a reimplementation has to produce and consume with nothing but this
 * module's algorithm and string concatenation, so its shape is part of the
 * contract in `docs/decisions/encryption.md` and not an internal detail.
 *
 * @param {{workspaceId: string, current: string, keys: Array<{generation: string, material: string}>}} input
 * @returns {object} the export document, ready for `JSON.stringify`
 */
export function renderKeyExport({ workspaceId, current, keys }) {
  requireWorkspaceId(workspaceId);
  if (typeof current !== "string" || current === "") {
    throw new NoteCryptoError("a key export must name its current generation");
  }
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new NoteCryptoError("a key export must include at least one key generation");
  }
  const seen = new Set();
  const entries = keys.map((entry) => {
    if (!entry || typeof entry.generation !== "string" || typeof entry.material !== "string") {
      throw new NoteCryptoError("a key export entry must have a generation and material");
    }
    const generation = requireKeyId(entry.generation);
    keyBytesFrom(entry.material); // shape-validates the material without holding onto the bytes
    if (seen.has(generation)) {
      throw new NoteCryptoError("a key export cannot repeat a generation");
    }
    seen.add(generation);
    return { generation, alg: CONTENT_ALG, key: entry.material };
  });
  if (!seen.has(current)) {
    throw new NoteCryptoError("a key export's current generation must be one of its own keys");
  }
  return {
    v: KEY_EXPORT_VERSION,
    workspace_id: workspaceId,
    exported_at: new Date().toISOString(),
    current,
    keys: entries,
    envelope: { version: ENVELOPE_VERSION, alg: CONTENT_ALG, spec: "docs/decisions/encryption.md" },
  };
}

/**
 * The inverse of `renderKeyExport`: validate an export document (parsed JSON,
 * not yet trusted) and answer the `{workspaceId, keys}` shape `decryptNote`
 * and `rewrapWorkspaceRecipient` accept.
 *
 * This is what the offline decryptor calls before it opens a single note, so
 * every failure here is a message an owner reads on their own machine with no
 * gateway and no control plane to ask — hence the spelled-out reasons rather
 * than a single "invalid export".
 *
 * @param {unknown} doc parsed JSON
 * @returns {{workspaceId: string, current: string, keys: Record<string,string>}}
 */
export function parseKeyExport(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new NoteCryptoError("key export is not a JSON object");
  }
  if (doc.v !== KEY_EXPORT_VERSION) {
    throw new NoteCryptoError(`unsupported key export version ${describeField(doc.v)}`);
  }
  if (typeof doc.workspace_id !== "string" || doc.workspace_id.length === 0) {
    throw new NoteCryptoError("key export is missing workspace_id");
  }
  if (typeof doc.current !== "string" || doc.current.length === 0) {
    throw new NoteCryptoError("key export is missing current");
  }
  if (!Array.isArray(doc.keys) || doc.keys.length === 0) {
    throw new NoteCryptoError("key export has no keys");
  }
  const keys = {};
  for (const entry of doc.keys) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new NoteCryptoError("key export has a malformed key entry");
    }
    if (typeof entry.generation !== "string" || typeof entry.key !== "string") {
      throw new NoteCryptoError("key export has a malformed key entry");
    }
    if (entry.alg !== CONTENT_ALG) {
      throw new NoteCryptoError(`key export entry has an unsupported algorithm ${describeField(entry.alg)}`);
    }
    keyBytesFrom(entry.key);
    keys[entry.generation] = entry.key;
  }
  if (!Object.prototype.hasOwnProperty.call(keys, doc.current)) {
    throw new NoteCryptoError("key export's current generation is not among its own keys");
  }
  return { workspaceId: doc.workspace_id, current: doc.current, keys };
}
