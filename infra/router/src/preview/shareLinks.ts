/**
 * Share links: `/s/<token>`, the one preview allowed to say a title, and its
 * card image.
 *
 * Split out of `../preview.ts`; see that file's docblock for why nothing here
 * ever fetches a workspace.
 */

import { GENERIC_PREVIEW, ORIGIN, normalisePath, type PreviewMeta } from "./meta";
import { boundTitle } from "./textBounds";

/* ────────────────────────────────────────────────────────────────────────────
 * SHARE LINKS — the one deliberate exception, and why it is not a hole
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Where a shared note lives: `/s/<token>`.
 *
 * Deliberately not `/share/…`, which is in the byte-identity set above and
 * stays there. A new prefix means the frozen-card guarantee for every existing
 * path is untouched by this feature rather than carved out of.
 */
export const SHARE_PREFIX = "/s/";

/**
 * The share token in a path, or `null`.
 *
 * Shape-checked here, before anything is fetched, and the token half of the
 * shape is exact: 64 lowercase hex characters, which is what
 * `randomOpaqueToken()` produces in the control plane. Three things follow from
 * checking rather than forwarding:
 *
 *  - Nothing an attacker types reaches an upstream. A path is either a
 *    well-formed link or it is not a share link at all.
 *  - `/s/`, `/s/x/y`, and `/s/../../etc` are not share links, so they fall
 *    through to GENERIC_PREVIEW like everything else.
 *  - A malformed token costs no round trip, so the obvious probe — hammer `/s/`
 *    with garbage and time the answers — never reaches the lookup.
 *
 * ## The readable half, and why it does not weaken any of that
 *
 * A link may carry the note's name in front of its token —
 * `/s/Chapter-transition-<64 hex>`, Notion's shape — because a URL that says
 * nothing is one people paste without knowing what they are sending. **The slug
 * is decoration and the token is the capability.** Nothing here or upstream
 * looks the slug up, so a renamed note does not break a link already sent, and
 * two links with different slugs are the same link if their tokens match.
 *
 * The entropy is untouched: the token is still the whole 64 hex and is still
 * matched exactly. It is read off the **end**, with a single hyphen in front of
 * it, so a slug that happens to contain hex is still only ever a slug —
 * anchoring rather than searching is what keeps the parse unambiguous.
 *
 * A bare 64-hex path stays valid, because every link minted before this existed
 * is that shape and they are live in other people's messages.
 *
 * `apps/mobile/features/share/share.ts` holds the same rule for the app, and
 * the two are held the way two copies are always held here — by running both
 * over the same shapes, in `preview.test.ts`.
 */
export function shareTokenFrom(pathname: string): string | null {
  if (!pathname.startsWith(SHARE_PREFIX)) return null;
  const rest = normalisePath(pathname).slice(SHARE_PREFIX.length);
  if (/^[0-9a-f]{64}$/.test(rest)) return rest;
  const match = /^([A-Za-z0-9][A-Za-z0-9-]*)-([0-9a-f]{64})$/.exec(rest);
  return match === null ? null : (match[2] ?? null);
}

/**
 * The card a shared link unfurls with.
 *
 * ## Why this is allowed to say something when nothing else is
 *
 * The rule above — one frozen card for every name-bearing path — exists because
 * `/@seyi` is **guessable**. A nicer preview of it would hand anyone an
 * existence oracle for usernames, which is exactly what the control plane's
 * byte-identical errors are built to deny.
 *
 * A share token is not guessable. It is 32 bytes from `crypto.getRandomValues`
 * that the owner deliberately handed to one person, and `shareTokenFrom` above
 * refuses to forward anything that is not shaped like one. So the premise the
 * frozen card protects — "the requester may not have been meant to have this
 * URL" — does not hold here, and the product need it blocks is real: a link
 * that unfurls as bare branding does not get clicked, and a share nobody opens
 * is a share that did not happen.
 *
 * The trade was made explicitly, and it is a real cost: **anyone holding the
 * URL learns the title without signing in.** Everyone in the channel it was
 * pasted into, everyone on the forwarded thread, the corporate link scanner.
 * Note *content* still requires authentication and a live grant; the owner can
 * turn the title off per share; and revoking makes the card frozen again.
 *
 * ## What it still refuses to do
 *
 *  - **`title` only.** No owner, no context name, no path, no folder, no date,
 *    no counts. The upstream returns exactly one field for this reason.
 *  - **The canonical URL stays the site root.** Echoing the requested path back
 *    would make two share links differ by their own bytes, which is the leak
 *    the whole file is built to avoid.
 *  - **`noindex, nofollow` stays.** A share is not search-engine material, and
 *    this is the half of "not published" that survives the card getting a
 *    title.
 *  - **The image is unchanged.** A per-share picture would leak through the
 *    pixels what the text withholds.
 *
 * A `null` title — unknown token, revoked, expired, title switched off — is
 * GENERIC_PREVIEW, byte for byte. That is what keeps revocation invisible: a
 * crawler cannot tell a share that was taken back from one that never existed.
 */
export function previewForShare(
  title: string | null | undefined,
  token?: string,
  /**
   * Whether the link needs no account, which changes one sentence.
   *
   * "Sign in to read it" was true of every share there was and is false of an
   * unlisted link. A card that tells somebody to sign in when they need no
   * account is the product being wrong on the first surface a stranger sees —
   * and it is the kind of wrong that stops a link being opened at all, which
   * is the whole reason a share card carries a title in the first place.
   *
   * Defaulted `false`, so a caller that has not been taught about it asks for
   * the sign-in wording rather than promising open access. Every absence still
   * returns GENERIC_PREVIEW before this is read at all.
   */
  openToAnyone = false,
): PreviewMeta {
  // Cleaned and bounded, mirroring MAX_PREVIEW_TITLE and the control character
  // strip in the control plane. Done in both places on purpose: this one is
  // what protects the response when the upstream is wrong, and an edge that
  // trusts its upstream to have been careful is an edge with no bound at all.
  const bounded = boundTitle(title);
  if (bounded === null) return GENERIC_PREVIEW;

  return {
    ...GENERIC_PREVIEW,
    title: `${bounded} — Context`,
    description: openToAnyone
      ? "Shared with you on Context. Open it — no account needed — plain " +
        "markdown in a bucket its owner controls."
      : "Shared with you on Context. Sign in to read it — plain markdown in a " +
        "bucket its owner controls.",
    /**
     * The title is drawn into the card image too, not only into the tags.
     *
     * The `v=` is a **cache key, never an input.** The renderer re-resolves the
     * title from the token and ignores this parameter entirely — see
     * `shareCardPath`. That is the single most important property of this URL:
     * an endpoint that drew whatever text it was handed would turn context.lc
     * into an arbitrary-text image generator on our own domain, wearing our
     * branding, which is a ready-made phishing asset.
     */
    imageUrl: token === undefined ? undefined : `${ORIGIN}${shareCardPath(token, bounded)}`,
  };
}

/**
 * Where a share's card image lives, with a content hash as a cache-buster.
 *
 * The hash exists because the Workers Cache API is **per-datacenter**, and
 * `cache.delete` only purges the colo the Worker ran in — so a card cannot be
 * globally invalidated. Putting the title's hash in the path sidesteps that
 * entirely: a changed title is simply a different URL, and the old one is never
 * requested again.
 */
export function shareCardPath(
  token: string,
  title: string,
  children: readonly string[] = [],
): string {
  return `${SHARE_CARD_PREFIX}${token}.png?v=${hashTitle(cardSignature(title, children))}`;
}

export const SHARE_CARD_PREFIX = "/og/s/";

/**
 * Everything the card draws, as one string to hash.
 *
 * A folder link's card carries its name **and** two or three of the things
 * inside it, so the title alone no longer identifies the picture — and the URL
 * built from this hash is the only invalidation there is, because the Workers
 * Cache API is per-datacenter and `cache.delete` purges one colo.
 *
 * An empty child list must hash **exactly as the bare title did**, or every
 * note share in existence changes its card URL for a picture that has not
 * changed.
 *
 * Mirrored from `apps/convex/functions/lib/cardKey.ts`, which this package
 * cannot import, and pinned against it in `apps/convex/__tests__/shareCard.test.ts`
 * the same way `hashTitle` is — the two spellings name the same object in the
 * customer's bucket, so a disagreement is a card written once and never found.
 */
export function cardSignature(title: string, children: readonly string[] = []): string {
  return children.length === 0 ? title : `${title}\n${children.join("\n")}`;
}

/**
 * A short, stable digest of the title.
 *
 * FNV-1a, not a cryptographic hash, and it does not need to be: it is a cache
 * key. A collision means one card is served a little longer than it should be,
 * which is the same outcome as the CDN caches above already produce.
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
 * The share token in a card path, or `null`.
 *
 * The same exact shape check `shareTokenFrom` applies, for the same reason: a
 * path is either a well-formed token or it is not a card, so nothing an
 * attacker types reaches an upstream and a malformed probe never buys a round
 * trip to time.
 */
export function shareCardTokenFrom(pathname: string): string | null {
  if (!pathname.startsWith(SHARE_CARD_PREFIX)) return null;
  const rest = pathname.slice(SHARE_CARD_PREFIX.length);
  if (!rest.endsWith(".png")) return null;
  const token = rest.slice(0, -".png".length);
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}
