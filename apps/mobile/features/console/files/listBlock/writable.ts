/**
 * Which frontmatter keys a list or a folder page may write at all.
 *
 * `visibility` never. Who can read a note is `privacy.md`'s answer, set with
 * Share; a `visibility:` line would only be a description that disagrees with
 * it. The Properties panel refuses it for the same reason
 * (`noteEditor/propertyEdit.ts`). Compared without case, so `Visibility` is
 * no way round it.
 *
 * Pure and dependency-free: the list block's menu (inside the editor bundle)
 * and `writeNoteProperty` (the one road every list and folder page write
 * takes) both ask it, so a surface cannot offer what the write would refuse.
 */

const NOT_A_PROPERTY = new Set(["visibility"]);

export function isWritableProperty(key: string): boolean {
  return !NOT_A_PROPERTY.has(key.trim().toLowerCase());
}
