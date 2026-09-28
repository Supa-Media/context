/**
 * Which frontmatter keys a list or a folder page may write at all.
 *
 * `visibility` never. Who can read a note is `privacy.md`'s answer, set with
 * Share; a `visibility:` line would only be a description that disagrees with
 * it. The Properties panel refuses it for the same reason
 * (`noteEditor/propertyEdit.ts`). Compared without case, so `Visibility` is
 * no way round it.
 *
 * **And `folder:` on a page of the workspace's website, because that one
 * publishes.** A `folder:` line on a page under `website/` puts every note of
 * that folder the manifest already shows the workspace on the public site
 * (`docs/decisions/websites.md`, `packages/shared/src/websiteFolders.ts`) — the
 * owner minting a locator, in the words of non-negotiable #5. A cell in a list
 * is the one surface that cannot say so: the folder a block lists and the
 * column it shows are written in the block, and the note carrying it need not
 * be one the reader wrote. So the value is drawn and never offered; publishing
 * a folder stays an edit to the page, where the page is what you are looking
 * at. The same key on a note outside `website/` means nothing to anybody and
 * is written like any other.
 *
 * Pure and dependency-free: the list block's menu (inside the editor bundle)
 * and `writeNoteProperty` (the one road every list and folder page write
 * takes) both ask it, so a surface cannot offer what the write would refuse.
 */

const NOT_A_PROPERTY = new Set(["visibility"]);

/** Keys that publish, on the notes where they do. */
const PUBLISHES = new Set(["folder"]);

/**
 * The site's own folder. Exactly, and case-sensitively, the way the gateway's
 * own `touchesWebsite` reads it (`apps/mcp/src/activity/record.js`): a bucket
 * key is case-sensitive, so `Website/x.md` is another folder and no page of
 * the site, and `websites/x.md` is not under this one either.
 */
const WEBSITE_ROOT = "website";

function isWebsitePage(path: string | undefined): boolean {
  if (path === undefined) return false;
  const normalized = path.replace(/^\.?\//, "");
  return normalized.startsWith(`${WEBSITE_ROOT}/`);
}

/**
 * Whether `key` may be written at all, and — given the note it would be
 * written to — whether it may be written there.
 *
 * A caller with no path in hand gets the key's own answer, which is the wider
 * of the two: a surface that knows which note it is changing passes it.
 */
export function isWritableProperty(key: string, path?: string): boolean {
  const folded = key.trim().toLowerCase();
  if (NOT_A_PROPERTY.has(folded)) return false;
  return !(PUBLISHES.has(folded) && isWebsitePage(path));
}

/** Why `isWritableProperty` said no, as a sentence for a menu. */
export function whyNotWritable(key: string, path?: string): string {
  return PUBLISHES.has(key.trim().toLowerCase()) && isWebsitePage(path)
    ? "A page's folder publishes that folder on your site. Set it in the page."
    : "Who can see a note is set with Share, not as a property.";
}
