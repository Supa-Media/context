/**
 * Short links: `/@seyi/intake`, and the card image they may unfurl with.
 *
 * Split out of `../preview.ts`; see that file's docblock for why nothing here
 * ever fetches a workspace.
 */

import { GENERIC_PREVIEW, ORIGIN, normalisePath, type PreviewMeta } from "./meta";
import { decodeSafely, boundTitle } from "./textBounds";

/**
 * A short link: `/@seyi/intake`.
 *
 * Returns the handle and the name, or `null` when the URL is not one.
 * Shape-checked here, before anything is fetched, exactly as `shareTokenFrom`
 * and `consoleNoteFrom` are: a segment that could never have been claimed
 * never becomes an upstream request, so hammering `/@name/<junk>` costs a
 * regex rather than a round trip.
 *
 * ## Why this may unfurl, when `/@seyi` may not
 *
 * The hinge `consoleNoteFrom` turns on, applied to a second address: the probe
 * space is names the **owner** chose. There is no list of likely slugs,
 * because a slug exists only where somebody typed one, and the control plane
 * refuses every name this product writes — so the guessable ones cannot be
 * claimed at all. `/@seyi` itself is unchanged and still gets the frozen card:
 * a handle is guessable *and* unbounded, which is the combination the byte-
 * identity rule exists for.
 *
 * ## The shape is the control plane's, restated
 *
 * Lowercase Latin alphanumerics and hyphens, 1–48, no leading or trailing
 * hyphen. Duplicated because this package cannot import from `apps/convex`,
 * and held to it the way `shareSegment` is held: both run
 * `shortLinkSlug.fixtures.json`, so the two copies are compared against the
 * same corpus rather than against a comment saying they agree.
 *
 * Reserved words parse here and resolve to nothing upstream, deliberately: a
 * second list in this file would be a second place for the two to disagree.
 */
export function shortLinkFrom(url: URL): { handle: string; slug: string } | null {
  const segments = normalisePath(url.pathname).split("/").filter(Boolean);
  if (segments.length !== 2) return null;

  const first = decodeSafely(segments[0]);
  if (!first.startsWith("@")) return null;
  const handle = first.slice(1);
  // The same shape a name claim can have. Anything else never existed.
  if (!SHORT_LINK_HANDLE.test(handle)) return null;

  const slug = decodeSafely(segments[1]);
  if (!SHORT_LINK_SLUG.test(slug)) return null;

  return { handle, slug };
}

/** The control plane's `SHORT_LINK_SLUG_RE`, restated. See `shortLinkFrom`. */
export const SHORT_LINK_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/**
 * The shape a name claim can have, restated for the same reason the slug is.
 *
 * One constant rather than the literal it used to be, because there are two
 * readers of it now — the link and its card image — and a handle one accepts
 * and the other does not is a card address that 404s for a link that works.
 */
const SHORT_LINK_HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The card a short link unfurls with.
 *
 * This used to be the note's name and **no image**, and the reason was right
 * while its premise held: a card was addressed by the share's token, a short
 * link sits at a guessable address, and a short link may sit over an `anyone`
 * share where the token *is* the authorization — so a per-share card here
 * would have meant handing a capability to whoever typed the word.
 *
 * The premise is the part that turned out to be a choice. `SHORT_CARD_PREFIX`
 * addresses the same picture by the **handle and slug the crawler already
 * used to ask for the title**, so the image arrives and the token never moves.
 * Nothing new is disclosed either: the card says the note's name, which is
 * exactly what this function was already putting in `og:title`.
 *
 * `cardVersion` is an opaque digest from upstream rather than a hash computed
 * here. `shareCardPath` can hash the title because the title is all its card
 * draws; a folder card also draws two or three names from inside the folder,
 * and those names are not what a short link's preview discloses — so the
 * cache-buster comes back pre-computed and this file never sees them.
 *
 * No version means no card: never rendered, render failed, bucket refused,
 * title changed since the last successful render. All of them fall through to
 * the product's own image, which is the same absence a revoked link gives.
 */
export function previewForShortLink(
  title: string | null | undefined,
  handle?: string | null,
  slug?: string | null,
  cardVersion?: string | null,
): PreviewMeta {
  const bounded = boundTitle(title);
  if (bounded === null) return GENERIC_PREVIEW;
  const named =
    typeof handle === "string" &&
    typeof slug === "string" &&
    typeof cardVersion === "string" &&
    /^[0-9a-f]{8}$/.test(cardVersion) &&
    SHORT_LINK_HANDLE.test(handle) &&
    SHORT_LINK_SLUG.test(slug);
  return {
    ...GENERIC_PREVIEW,
    title: `${bounded} — Context`,
    description:
      "Shared with you on Context — plain markdown in a bucket its owner controls.",
    ...(named
      ? { imageUrl: `${ORIGIN}${shortLinkCardPath(handle as string, slug as string, cardVersion as string)}` }
      : {}),
  };
}

export const SHORT_CARD_PREFIX = "/og/n/";

/**
 * Where a short link's card lives.
 *
 * `/og/n/@seyi/intake.png?v=…`. The handle keeps its `@` so the path reads the
 * way the link does, and both halves are shape-checked before they are
 * interpolated — a path built by concatenation from anything an unfurler can
 * put in a URL is how a card address becomes an open redirect.
 */
export function shortLinkCardPath(handle: string, slug: string, version: string): string {
  return `${SHORT_CARD_PREFIX}@${handle.replace(/^@/, "")}/${slug}.png?v=${version}`;
}

/** The two halves of a short link's card path, or `null`. */
export function shortLinkCardFrom(
  pathname: string,
): { handle: string; slug: string } | null {
  if (!pathname.startsWith(SHORT_CARD_PREFIX)) return null;
  const rest = pathname.slice(SHORT_CARD_PREFIX.length);
  if (!rest.endsWith(".png")) return null;
  const [handle, slug, ...extra] = rest.slice(0, -".png".length).split("/");
  if (extra.length > 0 || handle === undefined || slug === undefined) return null;
  if (!handle.startsWith("@")) return null;
  const name = handle.slice(1);
  // The same shape checks `shortLinkFrom` applies, for the same reason: a path
  // that could never have been claimed never becomes an upstream request, so
  // hammering this address costs a regex rather than a round trip to time.
  if (!SHORT_LINK_HANDLE.test(name) || !SHORT_LINK_SLUG.test(slug)) return null;
  return { handle: name, slug };
}
