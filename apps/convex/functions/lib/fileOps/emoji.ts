/**
 * A workspace's own emoji's pictures, in its bucket.
 *
 * Each one is a single object in the opaque image store, `emoji-<name>.<ext>`.
 * Since 2026-10-14 their names, and the leaf each is under, are held in
 * Convex (`customEmoji`, `functions/emoji.ts`), which every list and every
 * "does this emoji exist" reads; the image store is listed only to import a
 * workspace (`listCustomEmoji`, `lib/smallData/sync.ts`). Everything here goes
 * through `writeImage` and `readImage`, so the store's own leaf rule, type
 * allow-list and size cap still decide what may land.
 */

import {
  CUSTOM_EMOJI_LEAF_PREFIX,
  CUSTOM_EMOJI_MAX_BYTES,
  CUSTOM_EMOJI_NAME,
  customEmojiLeaf,
  parseCustomEmojiLeaf,
} from "@context/shared/src/customEmoji";
import { sniffImageType } from "@context/shared/src/remoteImage.cjs";
import { IMAGE_PREFIX, readImage, writeImage } from "./images";
import { FileOpError, notFound } from "./errors";
import { LIST_PAGE_CAP, type FileStore } from "./store";

/** One emoji, as the listing found it. */
export interface CustomEmoji {
  name: string;
  leaf: string;
}

/**
 * Every emoji in the store, sorted by name. Read only by the import.
 *
 * Two objects for one name (`emoji-x.png` beside `emoji-x.gif`, which only a
 * hand-copied file can produce) list once, as the first by leaf, so a name
 * always means one picture.
 */
export async function listCustomEmoji(store: FileStore): Promise<CustomEmoji[]> {
  const byName = new Map<string, CustomEmoji>();
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix: IMAGE_PREFIX + CUSTOM_EMOJI_LEAF_PREFIX, cursor, limit: 1000 });
    for (const object of listing.objects) {
      const leaf = object.key.slice(IMAGE_PREFIX.length);
      if (leaf.includes("/")) continue;
      const parsed = parseCustomEmojiLeaf(leaf);
      if (parsed === null) continue;
      const seen = byName.get(parsed.name);
      if (seen === undefined || leaf < seen.leaf) byName.set(parsed.name, { name: parsed.name, leaf });
    }
    if (!listing.truncated) break;
    if (!listing.cursor || listing.cursor === cursor) {
      throw new FileOpError("LISTING_INCOMPLETE", "Context could not finish reading this workspace's emoji.");
    }
    cursor = listing.cursor;
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function assertName(name: string): void {
  if (!CUSTOM_EMOJI_NAME.test(name)) {
    throw new FileOpError(
      "PATH_INVALID",
      "An emoji name is lowercase letters, numbers, - and _, starting with a letter or number.",
    );
  }
}

/**
 * The leaf Convex holds for `name`, checked: an emoji's own leaf and nothing
 * else in the image store, whatever a row says.
 */
function leafOf(name: string, leaf: string): string {
  if (!CUSTOM_EMOJI_NAME.test(name) || parseCustomEmojiLeaf(leaf)?.name !== name) throw notFound();
  return leaf;
}

/**
 * Store an emoji. The bytes decide the type, never the caller.
 *
 * Whether the name is free, or is being replaced, is the caller's to decide
 * from the names Convex holds (`functions/emoji.ts`); `previous` is the leaf
 * the name was stored under, removed afterwards when the new picture is of
 * another type, so a name never ends up meaning two pictures. Written before
 * anything is removed: a failure part-way leaves the old picture, not none.
 */
export async function storeCustomEmoji(
  store: FileStore,
  options: { name: string; bytes: Uint8Array; previous: string | null },
): Promise<CustomEmoji> {
  assertName(options.name);
  if (options.bytes.byteLength > CUSTOM_EMOJI_MAX_BYTES) {
    throw new FileOpError("CONTENT_TOO_LARGE", `An emoji must be at most ${CUSTOM_EMOJI_MAX_BYTES / 1_000_000} MB.`);
  }
  const type = sniffImageType(options.bytes);
  const leaf = type === null ? null : customEmojiLeaf(options.name, type.contentType);
  if (type === null || leaf === null) {
    throw new FileOpError("PATH_INVALID", "An emoji must be a PNG, JPEG, GIF or WebP image.");
  }
  const previous = options.previous === null ? null : leafOf(options.name, options.previous);
  await writeImage(store, { leaf, bytes: options.bytes, contentType: type.contentType });
  if (previous !== null && previous !== leaf) await store.delete(IMAGE_PREFIX + previous);
  return { name: options.name, leaf };
}

/** An emoji's bytes and type, by the leaf Convex holds for its name. Missing is `FILE_NOT_FOUND`. */
export async function readCustomEmoji(
  store: FileStore,
  options: { name: string; leaf: string },
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const leaf = leafOf(options.name, options.leaf);
  const bytes = await readImage(store, leaf);
  const extension = parseCustomEmojiLeaf(leaf)?.extension;
  return { bytes, contentType: extension === "jpg" ? "image/jpeg" : `image/${extension}` };
}

/** Remove an emoji's picture. Notes that use it are not touched: they show the name. */
export async function removeCustomEmoji(store: FileStore, options: { name: string; leaf: string }): Promise<void> {
  assertName(options.name);
  await store.delete(IMAGE_PREFIX + leafOf(options.name, options.leaf));
}

/**
 * Rename an emoji: a copy under the new name, then the old one removed.
 * Whether the new name is free is the caller's to decide from Convex. Notes
 * keep the old `:name:`, which then shows as text.
 */
export async function renameCustomEmoji(
  store: FileStore,
  options: { from: string; to: string; leaf: string },
): Promise<CustomEmoji> {
  assertName(options.from);
  assertName(options.to);
  if (options.from === options.to) throw new FileOpError("DESTINATION_EXISTS", `That is already its name.`);
  const read = await readCustomEmoji(store, { name: options.from, leaf: options.leaf });
  const stored = await storeCustomEmoji(store, { name: options.to, bytes: new Uint8Array(read.bytes), previous: null });
  await store.delete(IMAGE_PREFIX + options.leaf);
  return stored;
}
