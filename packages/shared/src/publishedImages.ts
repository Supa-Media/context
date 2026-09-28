/**
 * The stored pictures a published page shows: every `![[leaf]]` and
 * `![alt](leaf)` outside code whose target is an object in the workspace's
 * image store.
 *
 * A site loads no images from anywhere, so a page's pasted pictures travel
 * inside its answer as `data:` URLs, the way its emoji do
 * (`apps/convex/functions/lib/websites/images.ts`). Only what the published
 * text embeds is read: publishing a page publishes the pictures in it and no
 * other object in the store. Each leaf is listed once.
 *
 * The target has to be a bare leaf, in the store's own leaf rule and of a type
 * a browser draws. Anything with a slash, a scheme or a `..` is not a stored
 * object and is left alone: a remote picture is a tracking pixel on a site,
 * and a path is a note, not an image.
 */

/** A leaf `readImage` accepts, of a type every browser draws. HEIC is left out. */
export const PUBLISHED_IMAGE_LEAF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(?:png|jpe?g|gif|webp)$/i;

const WIKI_EMBED = /!\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g;
const INLINE_EMBED = /!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;

export function publishedImageLeaves(markdown: string): string[] {
  const prose = markdown
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");
  const leaves = new Set<string>();
  for (const pattern of [WIKI_EMBED, INLINE_EMBED]) {
    for (const match of prose.matchAll(pattern)) {
      const leaf = match[1].trim();
      if (PUBLISHED_IMAGE_LEAF.test(leaf) && !leaf.includes("..")) leaves.add(leaf);
    }
  }
  return [...leaves];
}
