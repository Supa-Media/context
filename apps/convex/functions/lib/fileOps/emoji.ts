/**
 * A workspace's own emoji, in its bucket.
 *
 * Each one is a single object in the opaque image store, `emoji-<name>.<ext>`,
 * and the object's name is the whole record — see `@context/shared`'s
 * `customEmoji.ts` for why there is no list file. Everything here goes through
 * `writeImage` and `readImage`, so the store's own leaf rule, type allow-list
 * and size cap still decide what may land.
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
 * Every emoji in the store, sorted by name.
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

/** Every leaf a name is stored under: normally one. */
async function leavesFor(store: FileStore, name: string): Promise<string[]> {
  const all: string[] = [];
  const listing = await store.list({ prefix: `${IMAGE_PREFIX}${CUSTOM_EMOJI_LEAF_PREFIX}${name}.`, limit: 1000 });
  for (const object of listing.objects) {
    const leaf = object.key.slice(IMAGE_PREFIX.length);
    if (parseCustomEmojiLeaf(leaf)?.name === name) all.push(leaf);
  }
  return all.sort();
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
 * Store an emoji. The bytes decide the type, never the caller.
 *
 * A name already taken is `DESTINATION_EXISTS` unless `replace` is set, and a
 * replacement of another type removes the old object afterwards, so a name
 * never ends up meaning two pictures. Written before anything is removed: a
 * failure part-way leaves the old picture, not none.
 */
export async function storeCustomEmoji(
  store: FileStore,
  options: { name: string; bytes: Uint8Array; replace: boolean },
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
  const existing = await leavesFor(store, options.name);
  if (existing.length > 0 && !options.replace) {
    throw new FileOpError("DESTINATION_EXISTS", `This workspace already has :${options.name}:.`);
  }
  await writeImage(store, { leaf, bytes: options.bytes, contentType: type.contentType });
  for (const old of existing) {
    if (old !== leaf) await store.delete(IMAGE_PREFIX + old);
  }
  return { name: options.name, leaf };
}

/** An emoji's bytes and type, by name. Missing is `FILE_NOT_FOUND`. */
export async function readCustomEmoji(
  store: FileStore,
  name: string,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  if (!CUSTOM_EMOJI_NAME.test(name)) throw notFound();
  const [leaf] = await leavesFor(store, name);
  if (leaf === undefined) throw notFound();
  const bytes = await readImage(store, leaf);
  const extension = parseCustomEmojiLeaf(leaf)?.extension;
  return { bytes, contentType: extension === "jpg" ? "image/jpeg" : `image/${extension}` };
}

/** Remove an emoji. Notes that use it are not touched: they show the name. */
export async function removeCustomEmoji(store: FileStore, name: string): Promise<void> {
  assertName(name);
  const leaves = await leavesFor(store, name);
  if (leaves.length === 0) throw notFound();
  for (const leaf of leaves) await store.delete(IMAGE_PREFIX + leaf);
}

/**
 * Rename an emoji: a copy under the new name, then the old one removed. The
 * new name must be free. Notes keep the old `:name:`, which then shows as text.
 */
export async function renameCustomEmoji(
  store: FileStore,
  options: { from: string; to: string },
): Promise<CustomEmoji> {
  assertName(options.from);
  assertName(options.to);
  if (options.from === options.to) throw new FileOpError("DESTINATION_EXISTS", `That is already its name.`);
  const read = await readCustomEmoji(store, options.from);
  const stored = await storeCustomEmoji(store, {
    name: options.to,
    bytes: new Uint8Array(read.bytes),
    replace: false,
  });
  await removeCustomEmoji(store, options.from);
  return stored;
}
