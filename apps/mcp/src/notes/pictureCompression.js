/**
 * The gateway's side of keeping pictures compressed
 * (`packages/shared/src/pictureCompression.cjs`, and
 * `docs/decisions/storage-and-credentials/files-bucket.md`).
 *
 * The Images binding lives on `env`, which the tool layer never sees, so a
 * request's store carries the one thing it needs, `compressPicture`, the way it
 * carries `mintImageUpload`: non-enumerable, request-scoped, and gone with the
 * request. A store with nothing attached (a test, a control-plane caller)
 * stores pictures as they came.
 */

import { compressPicture } from "../../../../packages/shared/src/pictureCompression.cjs";

/**
 * Compress one picture and log what happened: sizes and a reason, never a
 * name, a key or a byte of the picture.
 */
export async function compressAndLog(images, bytes, type, fields = {}) {
  const result = await compressPicture(images, bytes, type);
  const from = bytes?.byteLength ?? 0;
  console.log("picture.stored", {
    ...fields,
    from: type?.contentType ?? null,
    to: result.contentType,
    compressed: result.compressed,
    reason: result.reason,
    bytesIn: from,
    bytesOut: result.bytes?.byteLength ?? 0,
  });
  return result;
}

/** Give a request's store `compressPicture(bytes, type)` over this deployment's Images binding. */
export function attachPictureCompression(store, env, fields = {}) {
  if (!store || typeof store !== "object") return;
  Object.defineProperty(store, "compressPicture", {
    value: (bytes, type) => compressAndLog(env?.IMAGES, bytes, type, fields),
    enumerable: false,
    writable: false,
    configurable: true,
  });
}

/** The picture as it will be stored: compressed when the store can, as it came when it cannot. */
export async function pictureForStore(store, bytes, type) {
  if (typeof store?.compressPicture === "function") return await store.compressPicture(bytes, type);
  return { bytes, contentType: type.contentType, extension: type.extension, compressed: false, reason: "no_encoder" };
}
