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
import { fetchRemoteImage, sniffImageType } from "../../../../packages/shared/src/remoteImage.cjs";
import { parseLinks } from "../links.js";
import { imageRefFor } from "../tools/readImage.js";
import { pictureForStore } from "./pictureCompression.js";

// The ceilings, names and checks of one picture are pure, and Tex reads them too
// (`packages/shared/src/texContract/uploadImages.cjs`).
import {
  MAX_IMAGES_PER_WRITE,
  MAX_UPLOADED_IMAGE_BYTES,
  MAX_UPLOADED_BYTES_PER_WRITE,
  SHA256_PATTERN,
  UPLOAD_EXTENSIONS,
  decodeBase64,
  sha256Hex,
  uploadLeaf,
} from "../../../../packages/shared/src/texContract/uploadImages.cjs";
export {
  MAX_IMAGES_PER_WRITE,
  MAX_UPLOADED_IMAGE_BYTES,
  MAX_UPLOADED_BYTES_PER_WRITE,
  SHA256_PATTERN,
  UPLOAD_EXTENSIONS,
  embeddedUploadLeaf,
  sha256Hex,
  storableImage,
  uploadLeaf,
} from "../../../../packages/shared/src/texContract/uploadImages.cjs";

/**
 * The leaf a picture sent through an upload link is stored at: the **whole**
 * SHA-256.
 *
 * This name is asked for by hash later (`findUploadedImage`), and a truncated
 * one cannot answer that question honestly — a caller naming a full hash
 * would be answered from an object agreeing with only its first 64 bits. The
 * whole hash makes a hit proof of the bytes, with nothing to compare and no
 * body to read. The two paths therefore store the same picture under two
 * names, which costs one duplicate object and buys an exact answer.
 */
export function uploadLinkLeaf(sha256, extension) {
  return `upload-${sha256}.${extension}`;
}

/**
 * The stored leaf for a picture an agent sent with an upload link
 * (`notes/imageUploads.js`), by its SHA-256, or null. Only this workspace's
 * own store is asked, so a picture uploaded to another context is not found
 * here, whoever knows its hash.
 *
 * The leaf is the whole hash (`uploadLinkLeaf`), so finding one *is* the
 * check: there is no shorter name that another picture could also answer to,
 * and a caller naming 64 hex characters is answered about those 64.
 */
export async function findUploadedImage(store, sha256) {
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) return null;
  for (const extension of UPLOAD_EXTENSIONS) {
    const leaf = uploadLinkLeaf(sha256, extension);
    // `get`, not `head`: a session store answers `head` from the file tree,
    // which names notes and never the opaque image store. `read_image` reads
    // the same way. The body is not read.
    const found = await store.get(IMAGE_PREFIX + leaf);
    if (found) {
      try {
        await found.body?.cancel?.();
      } catch {
        // An unread body is let go either way.
      }
      return { leaf, ref: imageRefFor(leaf) };
    }
  }
  return null;
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
 * Where a picture came from ("original photograph", "AI-assisted concept"):
 * one line, no quote that would end the Markdown title it is written as.
 */
function cleanLabel(value) {
  if (typeof value !== "string") return "";
  return value.replace(/["\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
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
 *
 * A `label` says where a picture came from. It is written into the note as
 * the embed's Markdown title, `![alt](leaf "label")`, so it is plain text that
 * travels with the note and borrows its visibility, never a record beside it.
 * A `![[name]]` embed has no title, so a label on one is refused; a picture
 * named only in code is stored and reported as unlabelled (`labelLost`).
 */
export async function prepareNoteImages(content, images, store = null) {
  if (images === undefined) return { content, images: [] };
  if (!Array.isArray(images)) return { error: "images must be a list" };
  if (images.length > MAX_IMAGES_PER_WRITE) {
    return { error: `at most ${MAX_IMAGES_PER_WRITE} images per write` };
  }
  const names = new Set();
  const prepared = [];
  const compressing = [];
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
    // An empty field is an absent one: some clients send every field they are shown, the rest as "" (2026-11-25).
    const given = (value) => typeof value === "string" && value.trim() !== "";
    const hasData = given(image.data);
    const hasUrl = given(image.url);
    const hasUpload = given(image.sha256);
    if (Number(hasData) + Number(hasUrl) + Number(hasUpload) !== 1) {
      return { error: `${label}: pass exactly one of data (base64), url, or the sha256 of a picture sent with an upload link` };
    }
    if (hasUpload) {
      // Already in this workspace's store, put there by an upload link: found, never re-stored.
      const found = store ? await findUploadedImage(store, image.sha256.toLowerCase()) : null;
      if (!found) {
        return {
          error: `${label}: no picture with that sha256 was uploaded to this workspace; ask write with action upload for an upload link and run it first`,
        };
      }
      prepared.push({ name, leaf: found.leaf, key: IMAGE_PREFIX + found.leaf, stored: true, alt: cleanAlt(image.alt), label: cleanLabel(image.label) });
      continue;
    }

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
    // Named from the bytes that came in, so the same picture sent twice is
    // still one object; stored as the compressed copy (`pictureCompression.js`),
    // whose type names the extension.
    // Compressed all at once after this loop, not one after another: each
    // takes up to a second, and a page's photos are saved in one write.
    const entry = { name, alt: cleanAlt(image.alt), label: cleanLabel(image.label) };
    compressing.push({ label, entry, done: Promise.all([sha256Hex(bytes), pictureForStore(store, bytes, type)]) });
    prepared.push(entry);
  }
  for (const { label, entry, done } of compressing) {
    const [hash, picture] = await done;
    const leaf = uploadLeaf(hash, picture.extension);
    // The name this produces must be one `read_image` resolves, or the bytes
    // could never be read back out. Asserted rather than assumed.
    const ref = imageRefFor(leaf);
    if (!ref || ref.mimeType !== picture.contentType) return { error: `${label}: could not name the image` };
    Object.assign(entry, { leaf, key: IMAGE_PREFIX + leaf, bytes: picture.bytes, contentType: picture.contentType });
  }
  if (prepared.length === 0) return { content, images: [] };

  // Rewrite targets back to front so earlier spans keep their offsets.
  const byName = new Map(prepared.map((image) => [image.name, image]));
  const embedded = new Set();
  let next = content;
  const links = parseLinks(content).filter((link) => link.embed && byName.has(link.target.trim()));
  for (const link of links) {
    const image = byName.get(link.target.trim());
    if (image.label && link.kind === "wiki") {
      return {
        error: `${image.name}: a label is written as the picture's title, which only a ![alt](${image.name}) embed has; embed it that way`,
      };
    }
  }
  for (const link of links.sort((a, b) => b.start - a.start)) {
    const image = byName.get(link.target.trim());
    embedded.add(image.name);
    // Only where the embed has no title of its own: a title someone wrote stays.
    const titled = /^\s*["']/.test(next.slice(link.end));
    const title = image.label && !titled ? ` "${image.label}"` : "";
    next = next.slice(0, link.start) + image.leaf + title + next.slice(link.end);
  }
  const markdownEmbedded = new Set(embedded);
  next = rewriteCodeReferences(next, byName, embedded);
  for (const image of prepared) {
    if (image.label && embedded.has(image.name) && !markdownEmbedded.has(image.name)) image.labelLost = true;
  }
  const appended = prepared
    .filter((image) => !embedded.has(image.name))
    .map((image) =>
      image.label
        ? `![${image.alt}](${image.leaf} "${image.label}")`
        : `![[${image.leaf}${image.alt ? `|${image.alt}` : ""}]]`,
    );
  if (appended.length) {
    next = `${next.replace(/\s*$/, "")}${next.trim() ? "\n\n" : ""}${appended.join("\n\n")}\n`;
  }
  return { content: next, images: prepared };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A site's HTML and CSS name a picture with `src="logo.png"` or
 * `url(logo.png)`, not an embed; those point at the stored copy too, so an
 * agent writing a layout gets the picture where it put it rather than an
 * embed tacked on after the code. Only a value that is exactly an attached
 * name (optionally `./`-relative) is touched, and only its name.
 */
function rewriteCodeReferences(content, byName, embedded) {
  let next = content;
  for (const [name, image] of byName) {
    const target = `((?:\\./)?)${escapeRegExp(name)}`;
    const src = new RegExp(`(\\bsrc\\s*=\\s*)(["'])${target}\\2`, "gi");
    const url = new RegExp(`(\\burl\\(\\s*)(["']?)${target}\\2(\\s*\\))`, "gi");
    const before = next;
    next = next
      .replace(src, (_, lead, quote, dot) => `${lead}${quote}${dot}${image.leaf}${quote}`)
      .replace(url, (_, lead, quote, dot, close) => `${lead}${quote}${dot}${image.leaf}${quote}${close}`);
    if (next !== before) embedded.add(name);
  }
  return rewritePageFields(next, byName, embedded);
}

/**
 * A page (`.page.md`) names its pictures in fields, not embeds: `photo:
 * stand.jpg`, `photos: a.jpg, b.jpg`, `cover:` and a places block's `map:`
 * (`packages/shared/src/pages/`), and a bot's card names its logo in
 * `avatar:` and `avatar-dark:` (the area bots, 2026-11-25 and 2026-11-27). Each value that is exactly an
 * attached name becomes the stored copy's name, so the picture shows where
 * the writer put it, and it is not tacked on below as an embed.
 */
const PAGE_PICTURE_FIELD = /^([ \t]*(?:photos?|cover|map|avatar(?:-dark)?|drawing(?:-dark)?)[ \t]*:[ \t]*)(.+)$/gim;

function rewritePageFields(content, byName, embedded) {
  return content.replace(PAGE_PICTURE_FIELD, (_, lead, value) => {
    const names = value.split(",").map((part) => {
      const name = part.trim();
      const image = byName.get(name) ?? byName.get(name.replace(/^\.\//, ""));
      if (!image) return part;
      embedded.add(image.name);
      return part.replace(name, image.leaf);
    });
    return lead + names.join(",");
  });
}

/** Put every prepared image in the opaque store. Content-addressed, so a repeat is a no-op in effect. */
export async function storeNoteImages(store, images) {
  await Promise.all(
    images.filter((image) => !image.stored).map((image) => store.put(image.key, image.bytes, { contentType: image.contentType })),
  );
}
