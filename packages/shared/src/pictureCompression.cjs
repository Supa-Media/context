/**
 * Pictures are kept compressed (decided by the owner, 2026-11-01; see
 * `docs/decisions/storage-and-credentials/files-bucket.md`).
 *
 * Every way a picture enters a workspace's files bucket from a Worker runs it
 * through `compressPicture` first: a PNG screenshot, a JPEG photo, a WebP or an
 * iPhone HEIC becomes a lossy WebP no wider or taller than `PICTURE_MAX_EDGE`.
 * No lossless copy is kept. A GIF is kept as it came (it may move), and so is
 * anything that is not a picture: a PDF or a sound is stored byte for byte.
 *
 * The encoder is Cloudflare's Images binding (`env.IMAGES`), a platform API,
 * so the gateway stays free of a codec dependency. A deployment without the
 * binding (a self-hoster who left it out) stores the picture as it came and
 * says so in its log, rather than refusing it: compression saves space, it
 * guards nothing.
 *
 * Nothing the encoder hands back is trusted either. Its bytes must sniff as
 * WebP, be non-empty, and (unless the original is a HEIC, which no browser
 * draws) be smaller than what came in; otherwise the original is kept.
 */

const { sniffImageType } = require("./remoteImage.cjs");

/** The longest side a stored picture keeps, in pixels: sharp on a retina laptop, a quarter of a phone photo. */
const PICTURE_MAX_EDGE = 2560;

/** WebP quality, 1-100. */
const PICTURE_QUALITY = 80;

/** What a compressed picture is stored as. */
const COMPRESSED_PICTURE = Object.freeze({ contentType: "image/webp", extension: "webp" });

/** The types that are re-encoded. GIF is not (animation), and nothing that is not a picture is. */
const COMPRESSIBLE_PICTURE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"]);

/** Types a browser cannot draw, so a WebP replaces them even when it is not smaller. */
const UNDRAWABLE_TYPES = new Set(["image/heic", "image/heif"]);

function isCompressiblePicture(contentType) {
  return COMPRESSIBLE_PICTURE_TYPES.includes(contentType);
}

function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return null;
}

/**
 * `{ bytes, contentType, extension, compressed, reason }` for a picture about
 * to be stored. `type` is what its bytes sniffed as (`sniffImageType`), never
 * what a caller declared. `compressed` is false, with the bytes and type it
 * came with, whenever anything is off; `reason` then says why, for a log line
 * that carries no content.
 *
 * @param {{input: Function}|null|undefined} images the Images binding
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {{contentType: string, extension: string}} type
 */
async function compressPicture(images, bytes, type) {
  const original = toUint8Array(bytes);
  const kept = (reason) => ({ bytes: original ?? bytes, contentType: type.contentType, extension: type.extension, compressed: false, reason });
  if (!original || !type || !isCompressiblePicture(type.contentType)) return kept("not_compressible");
  if (!images || typeof images.input !== "function") return kept("no_encoder");
  let out;
  try {
    const stream = new Response(original).body;
    const result = await images
      .input(stream)
      .transform({ width: PICTURE_MAX_EDGE, height: PICTURE_MAX_EDGE, fit: "scale-down" })
      .output({ format: COMPRESSED_PICTURE.contentType, quality: PICTURE_QUALITY });
    out = new Uint8Array(await result.response().arrayBuffer());
  } catch {
    return kept("encoder_failed");
  }
  if (out.byteLength === 0 || sniffImageType(out)?.contentType !== COMPRESSED_PICTURE.contentType) return kept("encoder_answer_not_webp");
  if (out.byteLength >= original.byteLength && !UNDRAWABLE_TYPES.has(type.contentType)) return kept("not_smaller");
  return { bytes: out, contentType: COMPRESSED_PICTURE.contentType, extension: COMPRESSED_PICTURE.extension, compressed: true, reason: null };
}

module.exports = {
  PICTURE_MAX_EDGE,
  PICTURE_QUALITY,
  COMPRESSED_PICTURE,
  COMPRESSIBLE_PICTURE_TYPES,
  isCompressiblePicture,
  compressPicture,
};
