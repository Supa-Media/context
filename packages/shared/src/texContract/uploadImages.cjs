/**
 * A picture attached to a write: its ceilings, the name it is stored under, and
 * whether it can be stored at all. Pure, and moved verbatim from
 * `apps/mcp/src/notes/uploadedImages.js` (which re-exports it), so Tex names a
 * texted picture and checks a found photo without reaching a gateway module.
 */
"use strict";

const { MAX_REMOTE_IMAGE_BYTES, sniffImageType } = require("../remoteImage.cjs");

/** At most this many images per write. A note is a document, not a bulk import. */
const MAX_IMAGES_PER_WRITE = 10;

/** The most one image may be: the app's paste ceiling and `read_image`'s inline one. */
const MAX_UPLOADED_IMAGE_BYTES = MAX_REMOTE_IMAGE_BYTES;

/**
 * The most one write may carry across all its images. A Worker holds the
 * decoded bytes and the base64 they arrived as at the same time, so ten images
 * at the per-image ceiling would be a request that runs out of memory rather
 * than one that is refused in a sentence.
 */
const MAX_UPLOADED_BYTES_PER_WRITE = 15_000_000;

/** Base64 of the ceiling, with room for padding and stray whitespace. */
const MAX_BASE64_CHARS = Math.ceil(MAX_UPLOADED_IMAGE_BYTES / 3) * 4 + 1024;

/** A full SHA-256, lowercase hex: how an upload link names the bytes it takes. */
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Every extension the sniffer names, in the order a stored upload is looked for. */
const UPLOAD_EXTENSIONS = ["png", "jpg", "gif", "webp", "heic", "heif"];


/**
 * The upload this note embeds under the same hash as `leaf` but another extension, or null.
 *
 * A picture is named for its bytes' hash before it is stored, and the store may then keep a compressed copy under the
 * same hash with its own extension (`pictureCompression.js`, #2575): `upload-<hash>.jpg` is embedded as
 * `upload-<hash>.webp`. A caller holding the first name (Tex's record of a texted picture, 2026-11-23: every texted
 * picture since 2026-11-01 read back "not found") is answered from the second. Only a name this note itself embeds is
 * answered, so this reaches nothing `noteReferencesImage` would not.
 * @param {string} noteText the note's text
 * @param {string} leaf the name asked for, `upload-<hex>.<ext>`
 */
function embeddedUploadLeaf(noteText, leaf) {
  const stem = /^(upload-[0-9a-f]{16,64})\.[a-z0-9]+$/i.exec(String(leaf ?? ""))?.[1];
  if (!stem || typeof noteText !== "string") return null;
  return new RegExp(`(?<![0-9a-f])${stem}\\.(?:${UPLOAD_EXTENSIONS.join("|")}|jpeg)(?![A-Za-z0-9])`, "i").exec(noteText)?.[0] ?? null;
}


/**
 * The leaf a picture attached in the call itself is stored at, named from its
 * own content: a repeat is one object. Sixteen hex characters, which is the
 * name notes already written point at, so it does not change.
 *
 * Enough for dedupe, which is all it decides here: the bytes arrived in the
 * call, so nothing is looked up by this name. An upload link is the other
 * way round — there the name is the lookup — and uses the whole hash.
 */
function uploadLeaf(sha256, extension) {
  return `upload-${sha256.slice(0, 16)}.${extension}`;
}


async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}


/** The bytes of a base64 string or a `data:` URI, or null when it is not one or is past the ceiling. */
function decodeBase64(value) {
  // A data: URI is what most clients have to hand; its header is not trusted,
  // only stripped — the bytes decide the type below.
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  const raw = (comma === -1 ? value : value.slice(comma + 1)).replace(/\s+/g, "");
  if (!raw || raw.length > MAX_BASE64_CHARS) return null;
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(raw)) return null;
  const standard = raw.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(standard);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * The stored type of a base64 picture a write would accept, or null: what a
 * caller attaching pictures it found itself checks first, so one it could
 * never store (an AVIF, an SVG, an oversized photo) is left out rather than
 * refusing the whole write (`agent/visuals/pagePhotos.js`). The same checks
 * as `prepareNoteImages` below, which still decides.
 */
function storableImage(data) {
  const bytes = typeof data === "string" ? decodeBase64(data) : null;
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOADED_IMAGE_BYTES) return null;
  const type = sniffImageType(bytes);
  return type ? { contentType: type.contentType, bytes: bytes.byteLength } : null;
}

/**
 * The leaf `write_note` stores one picture's `data` under when the store keeps it as sent, and its size, or null:
 * what Tex names a texted picture before it writes it (`agent/textedPictures.js`). The write still checks
 * everything; a store that compresses names its copy under the same hash (`embeddedUploadLeaf`).
 */
async function sentPictureLeaf(data) {
  const bytes = typeof data === "string" ? decodeBase64(data) : null;
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOADED_IMAGE_BYTES) return null;
  const type = sniffImageType(bytes);
  if (!type) return null;
  return { leaf: uploadLeaf(await sha256Hex(bytes), type.extension), bytes: bytes.byteLength };
}

module.exports = {
  MAX_IMAGES_PER_WRITE,
  MAX_UPLOADED_IMAGE_BYTES,
  MAX_UPLOADED_BYTES_PER_WRITE,
  SHA256_PATTERN,
  UPLOAD_EXTENSIONS,
  embeddedUploadLeaf,
  uploadLeaf,
  sha256Hex,
  decodeBase64,
  storableImage,
  sentPictureLeaf,
};
