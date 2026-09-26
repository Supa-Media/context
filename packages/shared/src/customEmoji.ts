/**
 * A workspace's own emoji: the name rule, the object each one is stored as,
 * and the `:name:` a note writes to use one. Shared because the control plane
 * stores them and the editor draws them, and the two must agree on every name.
 *
 * ## Where they live
 *
 * In the opaque image store the paste path already writes to, as
 * `emoji-<name>.<ext>`. **The object's name is the whole record**: there is no
 * list file and no table, so the bucket describes itself — an export carries
 * the emoji, and one dropped in by hand (rclone, a restored backup) simply
 * appears. `emoji-` is a namespace in this store and not only a label the way
 * `paste-` is: every member may read any object that starts with it, which is
 * why nothing but the emoji writer ever produces such a leaf (pastes are
 * `paste-`, agent uploads `upload-`, icons `icon-`).
 *
 * ## How a note uses one
 *
 * As `:name:`, the form Slack and GitHub use. Obsidian, a text editor and
 * GitHub then show readable text rather than a broken image link, and the app
 * draws the picture. A standard emoji is written as the character itself.
 * See `docs/decisions/app-and-console/custom-emoji.md`.
 */

/**
 * A name: lowercase letters, digits, `_` and `-`, starting with a letter or a
 * digit. Every character is inside the image store's leaf class, so a name can
 * never build a leaf that walks out of the store.
 */
export const CUSTOM_EMOJI_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** What every custom emoji's leaf starts with. */
export const CUSTOM_EMOJI_LEAF_PREFIX = "emoji-";

/**
 * The most one emoji may be. Far under the store's five megabytes: an emoji
 * is drawn at text size, often several times in one note, and a two-megabyte
 * GIF is already a long one.
 */
export const CUSTOM_EMOJI_MAX_BYTES = 2_000_000;

/**
 * The types an emoji may be, by content type. Narrower than a paste: HEIC is
 * out because browsers do not draw it, and an emoji that shows on nobody's
 * screen is not one.
 */
export const CUSTOM_EMOJI_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

/** The leaf an emoji is stored under, or `null` for a bad name or type. */
export function customEmojiLeaf(name: string, contentType: string): string | null {
  const extension = CUSTOM_EMOJI_EXTENSIONS.get(contentType);
  if (extension === undefined || !CUSTOM_EMOJI_NAME.test(name)) return null;
  return `${CUSTOM_EMOJI_LEAF_PREFIX}${name}.${extension}`;
}

/** The emoji a leaf holds, or `null` when the leaf is not one. */
export function parseCustomEmojiLeaf(leaf: string): { name: string; extension: string } | null {
  if (!leaf.startsWith(CUSTOM_EMOJI_LEAF_PREFIX)) return null;
  const rest = leaf.slice(CUSTOM_EMOJI_LEAF_PREFIX.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return null;
  const name = rest.slice(0, dot);
  const extension = rest.slice(dot + 1).toLowerCase();
  if (!CUSTOM_EMOJI_NAME.test(name)) return null;
  if (![...CUSTOM_EMOJI_EXTENSIONS.values()].includes(extension)) return null;
  return { name, extension };
}

/**
 * A name made from whatever somebody typed or a file was called:
 * `Party Parrot.gif` → `party-parrot`. Empty when nothing usable is left.
 */
export function customEmojiNameFrom(text: string): string {
  return text
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
}

/**
 * The `:name:` shortcodes in a run of text, as offsets. A shortcode must not
 * touch a word character or another colon on either side, so `10:30:45`,
 * `http://x` and `a::b::c` are not emoji.
 */
export function findShortcodes(text: string): Array<{ from: number; to: number; name: string }> {
  const found: Array<{ from: number; to: number; name: string }> = [];
  const pattern = /(?<![\w:]):([a-z0-9+-][a-z0-9_+-]{0,63}):(?![\w:])/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    found.push({ from: match.index, to: match.index + match[0].length, name: match[1] });
  }
  return found;
}
