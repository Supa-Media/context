/**
 * Images an agent attaches to a note through `write_note`'s `images` argument.
 *
 * Before this, the only ways into the image store were a paste in the app and
 * an email attachment, so an agent could read a picture back (`read_image`) and
 * never put one in. This is the write half, and it is deliberately the paste's
 * shape rather than a new one:
 *
 *  - **The bytes land in the opaque store** (`IMAGE_PREFIX`), named from their
 *    own content, so the same image attached twice is one object and a retried
 *    write is idempotent. Nothing new appears in the customer's file tree.
 *  - **The note embeds the leaf** (`![[upload-<hash>.png]]`), which is what the
 *    app, `read_image` and the reference gate already resolve. The image has no
 *    visibility of its own and borrows the note's, exactly like a paste.
 *  - **The Markdown never carries the bytes or a remote URL.** A `url` is
 *    fetched once, here, and stored; the link written into the note is the
 *    workspace copy, so a remote host never sees a read (the tracking-pixel
 *    rule in `share/markdown.ts`).
 *  - **The type is decided by the bytes, never by the caller or the remote
 *    server.** A declared `image/png` that is really HTML or SVG is refused,
 *    because the store's content type is a header something may later trust.
 *
 * Nothing here writes. `prepareNoteImages` decodes, fetches, checks and names;
 * `storeNoteImages` puts the objects, and `toolWriteNote` calls it only after
 * every permission check has passed and before the note itself is written —
 * object first, then the line, the order the paste decision fixed so a failure
 * leaves an unreferenced object rather than a note pointing at nothing.
 */

import { IMAGE_PREFIX } from "../../../../packages/shared/src/storageLayout.cjs";
import { MAX_REMOTE_IMAGE_BYTES, fetchRemoteImage, sniffImageType } from "../../../../packages/shared/src/remoteImage.cjs";
import { parseLinks } from "../links.js";
import { imageRefFor } from "../tools/readImage.js";

/** At most this many images per write. A note is a document, not a bulk import. */
export const MAX_IMAGES_PER_WRITE = 10;

/** The most one image may be: the app's paste ceiling and `read_image`'s inline one. */
export const MAX_UPLOADED_IMAGE_BYTES = MAX_REMOTE_IMAGE_BYTES;

/**
 * The most one write may carry across all its images. A Worker holds the
 * decoded bytes and the base64 they arrived as at the same time, so ten images
 * at the per-image ceiling would be a request that runs out of memory rather
 * than one that is refused in a sentence.
 */
export const MAX_UPLOADED_BYTES_PER_WRITE = 15_000_000;

/** Base64 of the ceiling, with room for padding and stray whitespace. */
const MAX_BASE64_CHARS = Math.ceil(MAX_UPLOADED_IMAGE_BYTES / 3) * 4 + 1024;

async function contentHash(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

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

async function fetchImage(value, label) {
  const fetched = await fetchRemoteImage(value, (...request) => fetch(...request));
  if (fetched.error) return { error: `${label}: ${fetched.error}` };
  return { bytes: fetched.bytes };
}

/** Alt text for the alias slot: one line, no characters that would end the link. */
function cleanAlt(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\[\]|\r\n]+/g, " ").trim().slice(0, 200);
}

/**
 * Decode or fetch every attached image, check it, name it, and point the note
 * at it. Returns `{ content, images }` or `{ error }`; writes nothing.
 *
 * Each image carries a `name` — the placeholder the content uses for it. Every
 * embed whose target is exactly that name (`![[chart.png]]`,
 * `![a chart](chart.png)`) has its target replaced by the stored leaf, and
 * only the target: the alias, the width and the link style stay as written.
 * An image the content never embeds is appended on a line of its own, so an
 * attachment is never stored and silently left unreferenced.
 */
export async function prepareNoteImages(content, images) {
  if (images === undefined) return { content, images: [] };
  if (!Array.isArray(images)) return { error: "images must be a list" };
  if (images.length > MAX_IMAGES_PER_WRITE) {
    return { error: `at most ${MAX_IMAGES_PER_WRITE} images per write_note` };
  }
  const names = new Set();
  const prepared = [];
  let total = 0;
  for (const [index, image] of images.entries()) {
    const label = `images[${index}]`;
    if (!image || typeof image !== "object") return { error: `${label} must be an object` };
    const name = typeof image.name === "string" ? image.name.trim() : "";
    if (!name || name.length > 200 || /[\[\]|\r\n#]/.test(name)) {
      return { error: `${label}: name must be the file name the content embeds, e.g. chart.png` };
    }
    if (names.has(name)) return { error: `${label}: two images are named ${name}` };
    names.add(name);
    const hasData = typeof image.data === "string";
    const hasUrl = typeof image.url === "string";
    if (hasData === hasUrl) return { error: `${label}: pass exactly one of data (base64) or url` };

    let bytes;
    if (hasData) {
      bytes = decodeBase64(image.data);
      if (!bytes) {
        return {
          error: `${label}: data must be base64 (or a data: URI) of at most ${MAX_UPLOADED_IMAGE_BYTES} bytes`,
        };
      }
    } else {
      const fetched = await fetchImage(image.url, label);
      if (fetched.error) return { error: fetched.error };
      bytes = fetched.bytes;
    }
    if (bytes.byteLength === 0) return { error: `${label}: the image is empty` };
    if (bytes.byteLength > MAX_UPLOADED_IMAGE_BYTES) {
      return { error: `${label}: image is larger than ${MAX_UPLOADED_IMAGE_BYTES} bytes` };
    }
    total += bytes.byteLength;
    if (total > MAX_UPLOADED_BYTES_PER_WRITE) {
      return { error: `images together are larger than ${MAX_UPLOADED_BYTES_PER_WRITE} bytes; split them across writes` };
    }
    const type = sniffImageType(bytes);
    if (!type) {
      return { error: `${label}: not a PNG, JPEG, GIF, WebP or HEIC image (SVG is never stored)` };
    }
    const leaf = `upload-${await contentHash(bytes)}.${type.extension}`;
    // The name this produces must be one `read_image` resolves, or the bytes
    // could never be read back out. Asserted rather than assumed.
    const ref = imageRefFor(leaf);
    if (!ref || ref.mimeType !== type.contentType) return { error: `${label}: could not name the image` };
    prepared.push({ name, leaf, key: IMAGE_PREFIX + leaf, bytes, contentType: type.contentType, alt: cleanAlt(image.alt) });
  }
  if (prepared.length === 0) return { content, images: [] };

  // Rewrite targets back to front so earlier spans keep their offsets.
  const byName = new Map(prepared.map((image) => [image.name, image]));
  const embedded = new Set();
  let next = content;
  const links = parseLinks(content).filter((link) => link.embed && byName.has(link.target.trim()));
  for (const link of links.sort((a, b) => b.start - a.start)) {
    const image = byName.get(link.target.trim());
    embedded.add(image.name);
    next = next.slice(0, link.start) + image.leaf + next.slice(link.end);
  }
  const appended = prepared
    .filter((image) => !embedded.has(image.name))
    .map((image) => `![[${image.leaf}${image.alt ? `|${image.alt}` : ""}]]`);
  if (appended.length) {
    next = `${next.replace(/\s*$/, "")}${next.trim() ? "\n\n" : ""}${appended.join("\n\n")}\n`;
  }
  return { content: next, images: prepared };
}

/** Put every prepared image in the opaque store. Content-addressed, so a repeat is a no-op in effect. */
export async function storeNoteImages(store, images) {
  for (const image of images) {
    await store.put(image.key, image.bytes, { contentType: image.contentType });
  }
}
