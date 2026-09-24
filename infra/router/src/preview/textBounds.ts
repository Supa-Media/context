/**
 * Small text-shaping helpers shared by the note, short-link and share-link
 * previews.
 *
 * Split out of `../preview.ts`; see that file's docblock for why nothing here
 * ever fetches a workspace.
 */

export function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * A title from upstream, cleaned and bounded — or `null` if nothing survives.
 *
 * The strip is the one `boundChildren` applies to every child name, and the
 * reason is the stronger here: the title is the more prominent field, and for
 * an unlisted link it is the whole card. Bounding without cleaning was the rule
 * this file states in its own words — "an edge that trusts its upstream to have
 * been careful is an edge with no bound at all" — applied to length only.
 *
 * Cleaned BEFORE the length bound, so a title padded with format characters
 * cannot push real text past the cut.
 */
export function boundTitle(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const clean = title.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return clean === "" ? null : clean.slice(0, 60);
}
