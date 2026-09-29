/**
 * One step of moving a managed bucket from plain to encrypted, or back, per
 * object.
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
  let opened = null;
  try {
    opened = await cipher.open(new Uint8Array(await back.arrayBuffer()));
  } catch {
    // Falls through to the restore below: a sealed copy that will not open
    // is exactly the bad write the read-back exists to catch.
  }
  if (opened === null || !equalBytes(opened, bytes)) {
    await restore(bare, key, bytes, object.contentType, written.etag);
    throw new ManagedEncryptionError("VERIFY_FAILED", key);
  }
  return "sealed";
}

/**
 * One step of the way back: open a sealed object and write its plain bytes
 * in place. The mirror of `sealObject`, with the same guards: a conditional
 * write on the etag it read, then a read-back that must be exactly the plain
 * bytes. A sealed object that will not open stops the walk and is left as it
 * is; it is never replaced with anything.
 *
 * @returns {Promise<"unsealed"|"already"|"gone"|"raced">}
 */
export async function unsealObject(bare, cipher, key) {
  const object = await bare.get(key);
  if (!object) return "gone";
  const sealed = new Uint8Array(await object.arrayBuffer());
  if (!isManagedEnvelope(sealed)) return "already";
  const plain = await cipher.open(sealed);
  if (!object.etag) throw new ManagedEncryptionError("NO_ETAG", key);
  const written = await bare.put(key, plain, {
    contentType: writableType(object.contentType),
    onlyIf: { etagMatches: object.etag },
  });
  if (written === null) return "raced";
  const back = await bare.get(key);
  if (!back) return "gone";
  if (back.etag !== written.etag) return "raced";
  if (!equalBytes(new Uint8Array(await back.arrayBuffer()), plain)) {
    await restore(bare, key, sealed, object.contentType, written.etag);
    throw new ManagedEncryptionError("VERIFY_FAILED", key);
  }
  return "unsealed";
}

/**
 * The check before a walked-back workspace goes plain: is this object plain?
 *
 * @returns {Promise<"ok"|"sealed"|"gone">}
 */
export async function checkPlainObject(bare, key) {
  const object = await bare.get(key);
  if (!object) return "gone";
  return isManagedEnvelope(new Uint8Array(await object.arrayBuffer())) ? "sealed" : "ok";
}

/**
 * A read-back did not match: put back the bytes that were there before our
 * write, so a failed verify never leaves a bad copy as the only one. Only
 * over our own write: if somebody saved after it, theirs is newer and stays.
 * The original bytes are still in memory, which is why this can be exact.
 */
async function restore(bare, key, bytes, contentType, ourEtag) {
  await bare.put(key, bytes, {
    contentType: writableType(contentType),
    onlyIf: { etagMatches: ourEtag },
  });
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
