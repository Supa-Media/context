/**
 * Naming a share's card image.
 *
 * Pure, and shared by the writer (`shareCard.ts`) and the reader
 * (`shares.ts`'s unauthenticated preview query). One function so the two cannot
 * disagree about where a card lives — a writer and a reader with separate
 * spellings is a card that is written once and never found.
 */

/**
 * A short, stable digest of a title.
 *
 * FNV-1a, and it does not need to be cryptographic: it is a cache key, and the
 * only consequence of a collision is that a retitled share keeps its old card
 * until the next change. Deliberately the **same algorithm and width** as
 * `hashTitle` in `infra/router/src/preview.ts`, because the router puts this
 * value in the card's URL and the two must agree — asserted in
 * `__tests__/cardKey.test.ts` rather than left to a comment.
 */
export function hashTitle(title: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < title.length; i += 1) {
    hash ^= title.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The leaf a share's card is stored under.
 *
 * `card-<token[0,16]>-<titleHash>.png`. Three properties, each load-bearing:
 *
 *  - **It satisfies the gateway's leaf rule** — one segment, alphanumeric
 *    first character, an extension `read_image` will serve. A key the gateway
 *    cannot name is bytes nobody can ever get back out.
 *  - **The title hash makes a retitle a new object**, which is the only
 *    invalidation there is: the Workers cache is per-datacenter with no global
 *    purge, so a changed URL is how a new card reaches a crawler.
 *  - **The token is truncated to 16 characters.** A card in `.images/` is
 *    reachable by anybody who can read a note that references it, so the full
 *    64-character token — the capability itself — must not be sitting in a
 *    filename. Sixteen hex characters is 64 bits: enough that two shares in one
 *    bucket will not collide, and not enough to be a credential.
 */
export function cardImageLeaf(token: string, title: string): string {
  return `card-${token.slice(0, 16)}-${hashTitle(title)}.png`;
}
