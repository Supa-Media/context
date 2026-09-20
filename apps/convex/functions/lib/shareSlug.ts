/**
 * The owner-chosen half of a short link: `context.lc/@seyi/intake`.
 *
 * ## Why a name at all, when there is already an unguessable link
 *
 * `/s/Chapter-transition-<64 hex>` is safe *because* nobody can type it, and a
 * short link gives that up on purpose. The link somebody puts in an email
 * signature, reads out on a call, or prints on a card has to be sayable, and a
 * link that cannot be said is not the same product as one that can.
 *
 * **So a short link is a locator with a memorable name, never a wider tier.**
 * It resolves to the same `noteShares` row as its token, is authorised by
 * exactly the same code, and dies with the same revocation. The only thing it
 * changes is who can arrive at it: with the token, whoever was handed the URL;
 * with a slug, also whoever guesses `@seyi/intake`. That is the cost, it is
 * stated in the console before the name is claimed, and it is why claiming one
 * is a deliberate step rather than something minting a link does for you.
 *
 * ## What the shape refuses, and why each one
 *
 * A slug is **one path segment**, so it can never carry a path. Lowercase
 * Latin alphanumerics and hyphens, because it is typed off a business card by
 * somebody who did not see it written down, and case that has to be reproduced
 * exactly is a link that fails half the time.
 *
 * It is refused when it could ever mean something else at `/@name/<segment>`:
 *
 *  - **A name this product writes.** `1-projects`, `index`, `todo` and the rest
 *    come from `isProductMandatedPath`, which is the same list that decides
 *    whether a path may unfurl with a title. Today notes are addressed at
 *    `/console/@name?note=…` and there is no collision to have — but
 *    `CLAUDE.md` says the `@name/1-projects/foo.md` path prefix "can still
 *    arrive as sugar over the same routing", and a slug claimed today would
 *    have to be taken away from somebody to let it. Refusing them costs an
 *    owner nothing and keeps that door open.
 *  - **A word the console may want under a handle.** `settings`, `notes`,
 *    `files` and the rest: a future `/@seyi/settings` page must not have to
 *    fight a customer for its own address.
 *
 * The bound is 48 characters — shorter than `MAX_SHARE_SLUG`'s 60, which is a
 * *derived* decoration and can afford to be long. This one is typed by hand.
 * It also settles a rule that is not written here: a slug can never be
 * mistaken for a share token, because a token is 64 characters and this stops
 * at 48. A separate "not 64 hex" check was written, and the test that reached
 * for it found the length rule answering first — so it is one rule, stated
 * where it is enforced, rather than a second that never runs.
 */

import { isProductMandatedPath } from "./scaffold";

/** As long as a name somebody reads off a card should ever be. */
export const MAX_SHORT_LINK_SLUG = 48;

/**
 * Words the console may want under a handle.
 *
 * Deliberately small and deliberately not "every word we might ever use": a
 * reserved list that tries to be exhaustive ends up taking `notes`, `work` and
 * `about` away from every customer to protect pages nobody is going to build.
 * These are the ones an owner would be surprised to lose *later*.
 */
const RESERVED_SHORT_LINK_SLUGS: readonly string[] = [
  "settings",
  "account",
  "billing",
  "profile",
  "notes",
  "note",
  "files",
  "search",
  "share",
  "shares",
  "links",
  "admin",
  "api",
  "mcp",
  "oauth",
  "auth",
  "login",
  "logout",
  "connect",
  "invite",
  "og",
  "s",
  "t",
];

const SHORT_LINK_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/**
 * Why this slug cannot be claimed, or `null` when it can.
 *
 * A sentence the console shows the owner, not a code: every one of these is
 * something they can fix by typing a different word, and "invalid slug" sends
 * them to guess which rule they broke.
 */
export function shortLinkSlugRejection(slug: string): string | null {
  if (typeof slug !== "string" || slug.length === 0) {
    return "A short link needs a name.";
  }
  if (slug.length > MAX_SHORT_LINK_SLUG) {
    return `A short link's name is at most ${MAX_SHORT_LINK_SLUG} characters.`;
  }
  if (!SHORT_LINK_SLUG_RE.test(slug)) {
    return "A short link's name is lowercase letters, digits and hyphens, and cannot start or end with a hyphen.";
  }
  if (RESERVED_SHORT_LINK_SLUGS.includes(slug)) {
    return "That name is reserved for Context itself.";
  }
  // The product's own names, checked as the folder and as the file: `index` and
  // `index.md` are the same guess to somebody typing a URL, and only one of
  // them is in the list.
  if (isProductMandatedPath(slug) || isProductMandatedPath(`${slug}.md`)) {
    return "That name is one Context writes into every workspace, so it may come to mean a folder or a note.";
  }
  return null;
}

/** Whether this slug may be claimed. `shortLinkSlugRejection` says why not. */
export function isClaimableShortLinkSlug(slug: string): boolean {
  return shortLinkSlugRejection(slug) === null;
}

/**
 * The slug a `/@handle/<segment>` address names, or `null`.
 *
 * Shape-checked before anything is looked up, the way `shareTokenFrom` is at
 * the edge: a segment that could never have been claimed never becomes a query,
 * so hammering the address costs a regex rather than a round trip. This accepts
 * what `shortLinkSlugRejection` accepts and nothing else — including the
 * reserved words, which is deliberate: a reserved word resolves to nothing
 * because no row can hold it, not because a second list said so here.
 */
export function shortLinkSlugFrom(segment: string): string | null {
  if (typeof segment !== "string") return null;
  if (segment.length === 0 || segment.length > MAX_SHORT_LINK_SLUG) return null;
  if (!SHORT_LINK_SLUG_RE.test(segment)) return null;
  return segment;
}
