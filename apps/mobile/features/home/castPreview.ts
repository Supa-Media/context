import { splitWebsiteCast } from "@context/shared";
import { stripFrontmatter } from "../share/markdown";
import { parseHomeSnapshot, type HomeSnapshot } from "./homeSnapshot";

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

/** The draft as a one-page site whose front page it is. */
export function castPreviewSnapshot(source: string, title: string): HomeSnapshot {
  return {
    siteName: "Preview",
    revision: null,
    pages: [{ path: "index.md", routePath: "/", title, markdown: CAST_PREVIEW_BANNER + stripFrontmatter(source) }],
    emoji: {},
    // A draft's own images are the workspace's, which the homepage cannot read.
    images: {},
  };
}

/** The address that plays this draft on the homepage. */
export function castPreviewHref(source: string, title: string): string {
  const body = JSON.stringify({ title, markdown: stripFrontmatter(source) });
  return `/#${CAST_PREVIEW_PARAM}=${toBase64Url(new TextEncoder().encode(body))}`;
}

/** The draft an address carries, or `null` for any other visit or junk. */
export function castPreviewFrom(hash: string | undefined): HomeSnapshot | null {
  if (hash === undefined) return null;
  const prefix = `#${CAST_PREVIEW_PARAM}=`;
  if (!hash.startsWith(prefix)) return null;
  try {
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(hash.slice(prefix.length)))) as {
      title?: unknown;
      markdown?: unknown;
    };
    if (typeof body.title !== "string" || typeof body.markdown !== "string") return null;
    // Through the same check as a site from the router, so a crafted address
    // can hand the homepage nothing a real site could not.
    return parseHomeSnapshot(castPreviewSnapshot(body.markdown, body.title));
  } catch {
    return null;
  }
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
