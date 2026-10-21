/**
 * Which frontmatter keys a list or a folder page may write at all.
 *
 * `visibility` never. Who can read a note is `privacy.md`'s answer, set with
 * Share; a `visibility:` line would only be a description that disagrees with
 * it. The Properties panel refuses it for the same reason
 * (`noteEditor/propertyEdit.ts`). Compared without case, so `Visibility` is
 * no way round it.
 *
 * **And `folder:`, on any note, because on a page of the website that one
 * publishes.** A `folder:` line on a site page puts every note of that folder
 * the manifest already shows the workspace on the public site
 * (`docs/decisions/websites.md`, `packages/shared/src/websiteFolders.ts`) — the
 * owner minting a locator, in the words of non-negotiable #5. A cell in a list
 * is the one surface that cannot say so: the folder a block lists and the
 * column it shows are written in the block, and the note carrying it need not
 * be one the reader wrote. So the value is drawn and never offered; publishing
 * a folder stays an edit to the page, where the page is what you are looking
 * at. Since the website's folder can be nested anywhere and renamed (owner,
 * 2026-10-21), a path no longer says which notes are its pages, so the key is
 * held back everywhere: on a note outside the site it means nothing, and
 * costs nothing to set in the note itself.
 *
 * Pure and dependency-free: the list block's menu (inside the editor bundle)
 * and `writeNoteProperty` (the one road every list and folder page write
 * takes) both ask it, so a surface cannot offer what the write would refuse.
 */

const NOT_A_PROPERTY = new Set(["visibility"]);

/** Keys that publish on a website page, wherever its folder is. */
const PUBLISHES = new Set(["folder"]);

/** Whether a list or folder page may write `key`, on any note. */
export function isWritableProperty(key: string): boolean {
  const folded = key.trim().toLowerCase();
  return !NOT_A_PROPERTY.has(folded) && !PUBLISHES.has(folded);
}

/** Why `isWritableProperty` said no, as a sentence for a menu. */
export function whyNotWritable(key: string): string {
  return PUBLISHES.has(key.trim().toLowerCase())
    ? "On a website page, folder publishes that folder on your site. Set it in the note itself."
    : "Who can see a note is set with Share, not as a property.";
}
