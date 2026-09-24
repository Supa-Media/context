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

/*
 * The module is split by responsibility into `src/encryption/`, and this file
 * is its public face: every name the envelope exports is re-exported here, and
 * nothing else is. The folder is still one self-contained spec — none of its
 * files imports anything outside it, and none of them derives a key; the
 * gateway suite (`encryptionPassphrase.test.mjs`) reads every one of them to
 * hold that.
 */

export {
  ENVELOPE_VERSION,
  CONTENT_ALG,
  MARKER_KEY,
  KEY_MARKER_KEY,
  FENCE_LANGUAGE,
  RECIPIENT_WORKSPACE,
  KEY_EXPORT_VERSION,
  RECIPIENT_PASSPHRASE,
  KDF_ARGON2ID,
  KDF_LIMITS,
  NoteCryptoError,
  contentAad,
  wrapAad,
  generateWorkspaceKey,
} from "./encryption/primitives.js";
export {
  renderEncryptedNote,
  isEncryptedNote,
  indexableText,
  generatedNoteBytes,
  encryptedNoteKeyId,
  parseEncryptedNote,
  assertKdfDescriptor,
} from "./encryption/format.js";
export { encryptNote, decryptNote, rewrapWorkspaceRecipient } from "./encryption/workspace.js";
export { unwrapNoteKey } from "./encryption/noteKey.js";
export {
  encryptNoteForPassphrase,
  recipientsOf,
  hasRecipient,
  wrapNoteKeyForPassphrase,
  decryptNoteWithPassphrase,
  replacingRecipient,
} from "./encryption/passphrase.js";
export { renderKeyExport, parseKeyExport } from "./encryption/keyExport.js";
