/**
 * One step of moving a managed bucket from plain to encrypted, per object.
 *
 * The control plane drives the walk (a cursor over `list`, a page per run, the
 * same shape as the managed hand-off); this file is what it does to each key.
 * It runs against the **bare** adapter — no encryption wrapper, no
 * logical-delete view — because it has to see which bytes are still plain.
 *
 * Concurrency: people keep writing while this runs. Every seal is a
 * conditional write on the etag that was read, so a save that lands between
 * the read and the write wins, and the walk simply finds that object already
 * sealed (the gateway writes sealed in `migrating` mode) on its next pass.
 * Nothing a person typed is ever overwritten by an older copy.
 */

import { ATTACHMENT_CONTENT_TYPE, LOGICAL_DELETE_CONTENT_TYPE, WRITABLE_CONTENT_TYPES } from "./index.js";
import { ManagedEncryptionError, isManagedEnvelope } from "./managedEncryption.js";

/**
 * Seal one object in place if it is still plain.
 *
 * @param {import("./index.js").ContextStore} bare the adapter, unwrapped
 * @param {import("./managedEncryption.js").ManagedCipher} cipher
 * @param {string} key
 * @returns {Promise<"sealed"|"already"|"skipped"|"gone"|"raced">}
 *   `raced` means somebody wrote first; the caller counts it and moves on.
 */
export async function sealObject(bare, cipher, key) {
  const object = await bare.get(key);
  if (!object) return "gone";
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (isManagedEnvelope(bytes)) {
    // Opening it proves the key works for it; a failure here stops the
    // workspace rather than being counted as done.
    await cipher.open(bytes);
    return "already";
  }
  if (object.contentType === LOGICAL_DELETE_CONTENT_TYPE) return "skipped";
  // Never an unconditional write: without an etag there is no way to avoid
  // overwriting a save that landed after this read. Managed buckets are R2,
  // which always reports one.
  if (!object.etag) throw new ManagedEncryptionError("NO_ETAG", key);
  const sealed = await cipher.seal(bytes);
  const written = await bare.put(key, sealed, {
    contentType: writableType(object.contentType),
    onlyIf: { etagMatches: object.etag },
  });
  if (written === null) return "raced";
  // Read back and compare: the walk only counts an object as done once the
  // bucket demonstrably returns bytes that open to exactly what was there.
  const back = await bare.get(key);
  if (!back) return "gone";
  // A save that landed after our write is newer than what we sealed; it was
  // written through the wrapper, so it is sealed already.
  if (back.etag !== written.etag) return "raced";
  const opened = await cipher.open(new Uint8Array(await back.arrayBuffer()));
  if (!equalBytes(opened, bytes)) throw new ManagedEncryptionError("VERIFY_FAILED", key);
  return "sealed";
}

/**
 * The check before encrypted-only reads start: is this object sealed and does
 * it open? Deletion markers pass as they are.
 *
 * @returns {Promise<"ok"|"plain"|"gone">}
 */
export async function checkObject(bare, cipher, key) {
  const object = await bare.get(key);
  if (!object) return "gone";
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (!isManagedEnvelope(bytes)) {
    return object.contentType === LOGICAL_DELETE_CONTENT_TYPE ? "ok" : "plain";
  }
  await cipher.open(bytes);
  return "ok";
}

/**
 * The adapter only writes a known set of types. An object stored before that
 * allow-list (or by another tool) keeps a type we would refuse to send, so it
 * is sealed as an attachment rather than stopping the walk. Markdown and the
 * image types keep their own.
 */
function writableType(value) {
  if (value === undefined || value === null) return undefined;
  return WRITABLE_CONTENT_TYPES.has(value) ? value : ATTACHMENT_CONTENT_TYPE;
}

function equalBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
