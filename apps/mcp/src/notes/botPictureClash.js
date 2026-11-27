/**
 * A bot's logo is its own (Dev, 2026-11-27: four of @shyoh's bots all showed one orange picture). A bot in an app
 * like Grok cannot see its own profile picture, so asked to put its logo on its card it may send a picture it found
 * somewhere else, and several bots sent byte-identical ones. Context stored each on the right card; nothing told the
 * bot the picture was another bot's. So a write that names a new `avatar:` or `avatar-dark:` on a bot card is refused
 * when another bot card the writer can see already names that same picture.
 *
 * Pictures are compared by their content, the first 16 hex of the SHA-256 in the stored name: an upload link stores
 * `upload-<64 hex>.<ext>` and a write's own picture `upload-<16 hex>.<ext>`, the same bytes either way.
 */
import { factProps } from "../tree/facts.js";
import { isVisibleTextFile } from "../orient/survey.js";

const BOT_CARD = /(?:^|\/)bots\/[^/]+\/about\.md$/i;
const FIELDS = ["avatar", "avatar-dark"];

/** The picture a value names, by content: the first 16 hex of its hash, or null. */
export function pictureId(value) {
  const match = typeof value === "string" ? /upload-([0-9a-f]{16})[0-9a-f]*\.[a-z0-9]+/i.exec(value) : null;
  return match === null ? null : match[1].toLowerCase();
}

function frontMatterPictures(text) {
  const head = typeof text === "string" ? /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "" : "";
  const found = {};
  for (const field of FIELDS) found[field] = pictureId(new RegExp(`^${field}:[ \\t]*(.*)$`, "m").exec(head)?.[1] ?? "");
  return found;
}

/**
 * `{ card, field }` naming the other bot card that already shows the picture this write puts on `path`'s card, or
 * null. Only a picture the write changes is checked, so a card saved again as it was is never refused, and only
 * cards the writer can see are compared, so a refusal says nothing about a card it could not read.
 */
export async function botPictureClash(store, scope, rules, overrides, path, content, storedBody) {
  if (typeof path !== "string" || !BOT_CARD.test(path)) return null;
  const mine = frontMatterPictures(content);
  const before = frontMatterPictures(storedBody);
  const fresh = FIELDS.filter((field) => mine[field] !== null && mine[field] !== before[field]).map((field) => mine[field]);
  if (fresh.length === 0 || typeof store?.treeEntries !== "function") return null;
  const others = (await store.treeEntries().catch(() => []))
    .map((entry) => entry?.key)
    .filter((key) => typeof key === "string" && key !== path && BOT_CARD.test(key) && isVisibleTextFile(key, scope, rules, overrides));
  if (others.length === 0) return null;
  const props = await factProps(store, others);
  if (props === null) return null;
  for (const card of others) {
    const properties = props.get(card)?.props?.properties ?? {};
    for (const field of FIELDS) {
      const id = pictureId(typeof properties[field] === "string" ? properties[field] : "");
      if (id !== null && fresh.includes(id)) return { card, field };
    }
  }
  return null;
}
