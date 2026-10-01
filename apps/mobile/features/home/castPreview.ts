import { splitWebsiteCast } from "@context/shared";
import { stripFrontmatter } from "../share/markdown";
import { parseHomeSnapshot, type HomeSnapshot } from "./homeSnapshot";
import { emojiPictures, type EmojiPictures } from "../share/emojiPictures";

/**
 * "Preview demo": an owner's page, as the homepage would play it, before it
 * is published.
 *
 * The console cannot play a cast in its own editor: that editor is bound to
 * the real note, and a cast types into whatever it is bound to, so the show
 * would be saved into the owner's bucket. So the draft is handed to the
 * homepage instead, in a new tab, where it is the only page and the homepage's
 * own player types into a copy that lives in that tab. One player, one shell:
 * what the preview shows is what visitors get once the page is published.
 *
 * **The draft travels in the address's fragment** (`/#cast-preview=…`), which
 * a browser never sends to a server. It first travelled through this
 * browser's storage under a one-time key, which fails in two ways (Dev2,
 * 2026-09-29, "the play button for cast does not work"): the desktop app opens
 * every new window in the person's own browser, whose storage is not the
 * app's, so the homepage found nothing; and a browser whose storage the
 * offline note cache has filled throws on the write, so the button did
 * nothing. The address goes wherever the tab
 * goes, and reloading the tab plays the show again.
 */

export const CAST_PREVIEW_PARAM = "cast-preview";

/**
 * Said at the top of every preview, by the homepage rather than the address.
 *
 * Anybody can build one of these addresses, so a preview is a page on our
 * front door whose words somebody else chose. The homepage says so itself,
 * above whatever the address carries, so a link cannot pass a stranger's
 * page off as ours.
 */
export const CAST_PREVIEW_BANNER =
  "> [!info] Preview of an unpublished draft\n> This tab plays a page from its address. It is not the live site.\n\n";

/** Whether a note has a cast block worth previewing. */
export function hasCast(source: string): boolean {
  // Cheap first: this runs as the owner types.
  if (!/^ {0,3}`{3,}\s*cast\s*$/im.test(source)) return false;
  return splitWebsiteCast(stripFrontmatter(source)).steps.length > 0;
}

/**
 * A page a scene opens (`@maya opens: pricing`), carried beside the draft so
 * the preview has somewhere to go. `name` is what the script calls it, folders
 * and all (`inbox/james`): the preview puts the page at that path from the
 * scene (`previewPagePath`), so its tree shows the folder.
 */
export interface PreviewPage {
  name: string;
  title: string;
  markdown: string;
}

/** How many other pages one preview carries. */
export const MAX_PREVIEW_PAGES = 8;

/** `Pricing page` → `pricing-page`: the address a carried page gets. */
export function previewSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `inbox/James` → `inbox/james`: where a carried page sits beside the scene,
 * each folder kept as its own segment (`previewSlug` alone would flatten it to
 * `inbox-james`, a different page at the root). Leading and doubled slashes
 * are dropped, since the path is always from the scene's own folder; `null`
 * for a name that is not one, or that steps out of the scene (`..`, `.`).
 */
export function previewPagePath(name: string): string | null {
  const segments = name.replace(/\\/g, "/").split("/").filter((segment) => segment.trim() !== "");
  if (segments.length === 0 || segments.some((segment) => /^\.+$/.test(segment.trim()))) return null;
  const slugs = segments.map(previewSlug);
  return slugs.includes("") ? null : slugs.join("/");
}

/**
 * The draft as a site whose front page it is, with the pages its scene opens
 * beside it. `banner: false` only for the cast studio's stage, which our own
 * studio frames (`studioLink.ts`); otherwise every page says it, since a
 * crafted address can carry any page it likes.
 */
export function castPreviewSnapshot(
  source: string,
  title: string,
  options: { banner?: boolean; pages?: readonly PreviewPage[]; emoji?: EmojiPictures } = {},
): HomeSnapshot {
  const banner = options.banner === false ? "" : CAST_PREVIEW_BANNER;
  const pages = [{ path: "index.md", routePath: "/", title, markdown: banner + stripFrontmatter(source) }];
  const taken = new Set([""]);
  for (const page of (options.pages ?? []).slice(0, MAX_PREVIEW_PAGES)) {
    const at = previewPagePath(page.name);
    if (at === null || taken.has(at)) continue;
    taken.add(at);
    pages.push({ path: `${at}.md`, routePath: `/${at}`, title: page.title, markdown: banner + stripFrontmatter(page.markdown) });
  }
  return {
    siteName: "Preview",
    revision: null,
    pages,
    // The workspace emoji the scene uses, which the studio read for it.
    emoji: options.emoji ?? {},
    // A draft's own images are the workspace's, which the homepage cannot read.
    images: {},
  };
}

/** The address that plays this draft on the homepage. */
export function castPreviewHref(
  source: string,
  title: string,
  pages: readonly PreviewPage[] = [],
  emoji: EmojiPictures = {},
): string {
  return `/#${castPreviewFragment(source, title, pages, emoji)}`;
}

/** `cast-preview=…`: the draft, and the pages its scene opens, as the address's fragment carries them. */
export function castPreviewFragment(
  source: string,
  title: string,
  pages: readonly PreviewPage[] = [],
  emoji: EmojiPictures = {},
): string {
  const carried = pages.slice(0, MAX_PREVIEW_PAGES).map((page) => ({ ...page, markdown: stripFrontmatter(page.markdown) }));
  const body = JSON.stringify({
    title,
    markdown: stripFrontmatter(source),
    ...(carried.length === 0 ? {} : { pages: carried }),
    ...(Object.keys(emoji).length === 0 ? {} : { emoji }),
  });
  return `${CAST_PREVIEW_PARAM}=${toBase64Url(new TextEncoder().encode(body))}`;
}

/** The draft an address carries, or `null` for any other visit or junk. */
export function castPreviewFrom(hash: string | undefined, options: { banner?: boolean } = {}): HomeSnapshot | null {
  if (hash === undefined) return null;
  const prefix = `#${CAST_PREVIEW_PARAM}=`;
  if (!hash.startsWith(prefix)) return null;
  try {
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(hash.slice(prefix.length)))) as {
      title?: unknown;
      markdown?: unknown;
      pages?: unknown;
      emoji?: unknown;
    };
    if (typeof body.title !== "string" || typeof body.markdown !== "string") return null;
    const pages = body.pages === undefined ? [] : previewPages(body.pages);
    if (pages === null) return null;
    // Through the same check as a site from the router, so a crafted address
    // can hand the homepage nothing a real site could not.
    // Pictures are checked by the snapshot's own rules: inline images of four types, nothing an address could fetch.
    return parseHomeSnapshot(castPreviewSnapshot(body.markdown, body.title, { ...options, pages, emoji: emojiPictures(body.emoji) }));
  } catch {
    return null;
  }
}

/** Carried pages, or `null` when they are not all a name, a title and some text. */
function previewPages(value: unknown): PreviewPage[] | null {
  if (!Array.isArray(value) || value.length > MAX_PREVIEW_PAGES) return null;
  const pages: PreviewPage[] = [];
  for (const one of value as unknown[]) {
    if (typeof one !== "object" || one === null) return null;
    const { name, title, markdown } = one as Record<string, unknown>;
    if (typeof name !== "string" || typeof title !== "string" || typeof markdown !== "string") return null;
    if (previewPagePath(name) === null) return null;
    pages.push({ name, title, markdown });
  }
  return pages;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
