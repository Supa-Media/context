/**
 * The workspace emoji a published page carries, `name → data: URL`, checked.
 *
 * A site loads no images, so these arrive with the page (`lib/websites/emoji.ts`
 * in the control plane). Only a picture of one of the four types, inline, is
 * kept: anything else would be an address the reader's browser fetches, which
 * is exactly what a site never does. A dropped entry shows as its `:name:`.
 */

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PICTURE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX = 48;

export type EmojiPictures = Readonly<Record<string, string>>;

export function emojiPictures(value: unknown): EmojiPictures {
  const kept: Record<string, string> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return kept;
  for (const [name, url] of Object.entries(value).slice(0, MAX)) {
    if (NAME.test(name) && typeof url === "string" && PICTURE.test(url)) kept[name] = url;
  }
  return kept;
}
