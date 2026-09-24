import {
  CONTENT_ALG,
  ENVELOPE_VERSION,
  KEY_EXPORT_VERSION,
  NoteCryptoError,
  describeField,
  keyBytesFrom,
  requireKeyId,
  requireWorkspaceId,
} from "./primitives.js";

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
