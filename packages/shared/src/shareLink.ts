/**
 * The shape of a share link's URL — built here, parsed at the edge.
 *
 * ## Why this is in `packages/shared` rather than in the app
 *
 * Two places build this URL now. The console builds it when somebody presses
 * Copy link; the control plane builds it when an agent asks for a link through
 * the gateway and gets one back rather than a token to assemble. A second
 * builder is a second opinion about what a share link looks like, and the one
 * that drifts is the one nobody pastes into a chat and notices.
 *
 * This package is the sanctioned way anything reaches both the app's bundle
 * (Metro is configured with `sharedPackages: ["@context/shared"]`) and Convex.
 * `links.ts` beside this file is the same arrangement for the same reason.
 *
 * **The edge router still has its own parser**, in
 * `infra/router/src/preview.ts`, because it cannot import this package. That
 * pair is held the way two copies of a rule are always held here — by running
 * both over `shareSegment.fixtures.json` — and nothing in this file changes
 * that.
 */

/** Where a shared note lives. Must match `SHARE_PATH_PREFIX` in the console. */
export const SHARE_ROUTE = "/s";

/**
 * The longest a readable slug may be. Bounded because it goes in a URL people
 * paste into chat clients that truncate, and because an unbounded prefix is an
 * unbounded thing to validate at the edge.
 */
export const MAX_SHARE_SLUG = 60;

/**
 * A note's title as the readable half of a link — Notion's shape.
 *
 * `/s/<64 hex>` says nothing about what it points at, and a URL that says
 * nothing is one people paste without knowing what they are sending and open
 * without knowing what they are opening. `/s/Chapter-transition-<64 hex>` is
 * the same link with its subject in it.
 *
 * **The slug is decoration and the token is the capability**, which is the
 * property everything else here depends on: nothing looks the slug up, a
 * renamed note does not break a link already sent, and two links whose slugs
 * differ by a character are two different links only if their tokens differ.
 *
 * Latin alphanumerics only, joined by hyphens. Not a transliteration: a title
 * with no Latin letters yields `""` and the link is the bare token, which is
 * the honest outcome — a slug of percent-escapes is less readable than none,
 * and this feature is *only* about readability. Case is kept, because a title
 * is somebody's own words and lowercasing them reads as a machine's.
 */
export function shareSlug(title: string | null | undefined): string {
  if (typeof title !== "string") return "";
  return title
    .normalize("NFKD")
    // Anything that is not a Latin alphanumeric becomes a separator, including
    // the marks NFKD just split off — so "Chapter — transition" is two words
    // rather than two words and a stray dash.
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SHARE_SLUG)
    // Re-trimmed: the bound can cut mid-separator and leave a trailing hyphen,
    // which would make the slug run straight into the token's own separator
    // and the segment would stop parsing.
    .replace(/-+$/g, "");
}

/**
 * The path segment a link carries: `Chapter-transition-<64 hex>`, or the bare
 * token when there is no usable slug.
 *
 * One function, so the console and the viewer cannot build two shapes.
 */
export function shareSegment(token: string, title?: string | null): string {
  const slug = shareSlug(title);
  return slug === "" ? token : `${slug}-${token}`;
}

