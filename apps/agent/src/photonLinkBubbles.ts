/**
 * Tex's words with a link go out on Photon as two bubbles: the words, then the link alone with its preview
 * (`photonLine.ts` `sendPhotonWords`). The send is noted by the words' guid, so the link bubble's own reports (Apple's
 * echo, a read, a delivery check) named a guid no send had and were always unmatched (2026-11-17). Each link bubble is
 * kept here beside its words' guid, so those reports land on the same send.
 *
 * In memory, in the object that sent it, which is the object its reports go to; a few hundred at most. A report that
 * comes after the object was evicted is unmatched, as before.
 */

const MAX_KEPT = 300;
const kept = new Map<string, string>();

/** Notes that `link` is the link bubble of the words sent as `words`. */
export function noteLinkBubble(link: string | undefined, words: string | undefined): void {
  if (typeof link !== "string" || link === "" || typeof words !== "string" || words === "" || link === words) return;
  kept.delete(link);
  kept.set(link, words);
  if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
}

/** The words' guid a link bubble belongs to, or undefined for any other guid. */
export function linkBubbleWords(guid: string): string | undefined {
  return kept.get(guid);
}
