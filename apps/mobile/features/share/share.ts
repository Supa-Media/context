/**
 * Which screen `/s/<token>` shows, decided as a pure function.
 *
 * The same arrangement `features/invite/invite.ts` uses, for the same reason:
 * the interesting cases here are states — signed out, loading, unavailable,
 * a note that resolved, a linked note the reader navigated to — and every one
 * of them is testable without a router or a socket.
 *
 * ## The rule this screen must not soften
 *
 * **Every failure is the same screen.** Revoked, expired, addressed to somebody
 * else, entry note deleted, entry note made private, target not linked from the
 * entry note — the server answers all of them with one `SHARE_UNAVAILABLE`, and
 * this must not undo that by inferring a reason from context it happens to have.
 * Somebody holding a link who can tell "the owner revoked this" from "the owner
 * made it private" has learned two things about a context they are not in.
 *
 * ## Signed out is different, and is allowed to be
 *
 * "Sign in" is a fact about the reader's own session, not about the share, so
 * saying it discloses nothing — and it is the one thing they can act on. The
 * `next` parameter carries the token through, because the token is in one
 * message and nowhere else: losing it loses the share, and no rail entry can
 * reproduce it.
 *
 * ## …and it is the SERVER that says so, not this screen
 *
 * This used to redirect a signed-out reader to sign-in before asking the server
 * anything, which was right while every share required a session. One kind no
 * longer does: an unlisted link (`recipientKind: "anyone"`) is opened by
 * whoever holds it, and a screen that bounced them to sign-in would make the
 * feature unreachable for exactly the person it exists for.
 *
 * So the read is attempted with whatever session there is — none included — and
 * `NOT_AUTHENTICATED` coming back is what routes to sign-in. That is the ONE
 * code this screen may read, and it is safe for the reason above: the server
 * answers it for every anonymous caller whatever they presented, so an invented
 * token, a personal share, a members-only link and a revoked unlisted link all
 * arrive here identically. Reading any *other* code would reconstruct the
 * difference the server went to trouble to remove.
 *
 * The one thing that must still be waited for is auth *settling*. Firing the
 * read before a real session has attached would have a signed-in recipient's
 * first request answered anonymously, and bounce them to a sign-in they had
 * already done.
 *
 * ## Losing your session mid-read still takes the note away
 *
 * That property predates this and is *not* softened by it. `note` is component
 * state and survives the auth flip, so a screen that only consulted the server
 * once would leave somebody reading a note after they signed out — which is the
 * bug the "signed out refuses with a note already on screen" cases were written
 * for. What changed is only that "signed out" is no longer the same question as
 * "may not read this": an unlisted link's reader is signed out and entitled.
 *
 * So the server says which it is (`openToAnyone`), and a note that needed a
 * session is withdrawn the moment there is not one. Deriving that here from
 * "is there a session right now" is the tidy-up to refuse: it answers one of
 * the two cases wrong whichever way it is written.
 */

import { ConvexError } from "convex/values";

import { SHARE_ROUTE, shareSegment, shareSlug } from "@context/shared";

import { loginHref } from "../auth/redirect";

/*
  The URL builders live in `@context/shared` now, and are re-exported here so
  every existing importer is unchanged.

  Moved rather than copied. The control plane has to build the same URL — an
  agent asking for a link gets one back, and a URL it assembled itself would be
  a second builder free to disagree with this one about what a share link looks
  like. `packages/shared` is the sanctioned way anything reaches both the app's
  bundle and Convex, which is exactly the arrangement `links.ts` already uses
  for the same reason. The edge router still has its own *parser*, because it
  cannot import this package; that pair is held by
  `shareSegment.fixtures.json`.
*/
export {
  MAX_SHARE_SLUG,
  SHARE_ROUTE,
  shareSegment,
  shareSlug,
} from "@context/shared";

/**
 * The token inside a segment, or `null`.
 *
 * Deliberately strict, and the strictness is the same one `shareTokenFrom` in
 * `infra/router/src/preview.ts` applies for the same reason: a segment is
 * either a well-formed link or it is not one, so nothing a stranger types
 * becomes a lookup.
 *
 * The token is the **last 64 characters**, they must be lowercase hex, and what
 * precedes them must be a slug followed by a single hyphen. Anchoring at the
 * end rather than searching is what makes it unambiguous — a title that happens
 * to contain hex is still just slug, because only the tail is ever read as a
 * token. Sabotaging that anchor to a search fails the corpus both copies run.
 *
 * A bare 64-hex segment is accepted unchanged. Every link minted before this
 * existed is that shape, and they are live in other people's messages.
 */
export function shareTokenFromSegment(segment: string): string | null {
  if (/^[0-9a-f]{64}$/.test(segment)) return segment;
  const match = /^([A-Za-z0-9][A-Za-z0-9-]*)-([0-9a-f]{64})$/.exec(segment);
  if (match === null) return null;
  return match[2] ?? null;
}

/**
 * `/s/<segment>`, and `/s/<segment>?path=…` for a note reached from it.
 *
 * The segment is a path segment and the note is a query parameter, which is the
 * right way round: the segment names *what you have access to* and the path
 * names *where you are inside it*. A reader who edits the query gets a refusal
 * from the server, never a different share.
 *
 * Takes the segment rather than the token, so navigating between linked notes
 * inside a share keeps the readable URL the reader arrived on rather than
 * quietly rewriting it to the bare token halfway through.
 */
export function shareHref(segment: string, path?: string): string {
  const base = `${SHARE_ROUTE}/${encodeURIComponent(segment)}`;
  return path === undefined ? base : `${base}?path=${encodeURIComponent(path)}`;
}

/** The sign-in URL that comes back here afterwards. */
export function shareSignInHref(segment: string | null, path?: string): string {
  // A missing segment still goes to sign-in rather than to a dead end: the
  // reader has no way to fix the URL, and a signed-in reader at least lands
  // somewhere that explains itself.
  //
  // The **segment**, so the reader comes back to the URL they were on rather
  // than to a bare-token rewrite of it. Both resolve; only one of them is the
  // link they were sent.
  return loginHref(segment === null ? null : shareHref(segment, path));
}

/**
 * Where a short link lives: `/@seyi/intake`.
 *
 * A second address for the same share row, and the whole reason it exists is
 * that somebody can say it out loud. It resolves server-side to the row's
 * token, which never comes back here — see `readShortLink`.
 *
 * The shape is the control plane's, restated, for the reason the router
 * restates it too: a segment that could never have been claimed should not
 * become a request. All three copies run `shortLinkSlug.fixtures.json`.
 */
const SHORT_LINK_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const SHORT_LINK_HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** What a short link addresses, or `null` when the URL is not one. */
export interface ShortLinkAddress {
  /** The workspace's name, undecorated — `seyi`, never `@seyi`. */
  handle: string;
  slug: string;
}

/**
 * Read a short link out of its two route parameters.
 *
 * The `@` is stripped here rather than being part of the handle, so exactly
 * one form of the name exists downstream. A first segment without one is not a
 * short link at all — it is some other two-segment URL — and the caller sends
 * it to the not-found screen rather than to this page's uniform refusal, which
 * is the one case where telling the two apart helps somebody.
 */
export function shortLinkAddress(
  handle: string | null,
  slug: string | null,
): ShortLinkAddress | null {
  if (handle === null || slug === null) return null;
  if (!handle.startsWith("@")) return null;
  const name = handle.slice(1);
  if (!SHORT_LINK_HANDLE.test(name)) return null;
  if (!SHORT_LINK_SLUG.test(slug)) return null;
  return { handle: name, slug };
}

/** The URL of a short link, with an optional note inside it. */
export function shortLinkHref(address: ShortLinkAddress, path?: string): string {
  const base = `/@${encodeURIComponent(address.handle)}/${encodeURIComponent(address.slug)}`;
  return path === undefined ? base : `${base}?path=${encodeURIComponent(path)}`;
}

/**
 * A route parameter that may arrive as an array.
 *
 * Expo Router hands back `string[]` when a segment repeats — `/s/a/b` — and a
 * bare `string` assumption is how that becomes a crash rather than a refusal.
 */
export function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.length > 0 ? (value[0] ?? null) : null;
  return value ?? null;
}

/** One thing directly inside a shared folder. */
export interface SharedEntry {
  path: string;
  name: string;
  kind: "file" | "folder";
}

/** What `readSharedNote` returns, mirrored so this module needs no Convex. */
export interface SharedNote {
  path: string;
  /** The markdown, or `null` when `kind` is `folder`. */
  text: string | null;
  /**
   * Which half of this is filled.
   *
   * Reported by the server, never inferred from `text === null` or from the
   * path's extension: a reader arrives holding only a token and cannot know
   * what it points at, and a client that guessed would be a second place for
   * that answer to be wrong.
   */
  kind: "note" | "folder";
  /** What is directly inside, one level, when this is a folder. */
  entries: SharedEntry[];
  entryPath: string;
  links: string[];
  /** Whether this link needs no session. See the module comment. */
  openToAnyone: boolean;
  /**
   * The context this note can be edited in — `slug`, or `null`.
   *
   * Decided by the server from the reader's own membership. Never derived
   * here: a client working out for itself who may edit would be a second place
   * for that answer to be wrong, and the direction it fails is naming
   * somebody's context to a stranger holding a link.
   */
  editableInContext: string | null;
}

export type ShareResult = SharedNote | Error | undefined;

export interface ShareInputs {
  /**
   * The token, or `null` when the URL does not carry a well-formed one.
   *
   * A segment whose tail is not 64 hex is not a share link, and it reaches the
   * same screen a spent token does rather than a different one.
   */
  token: string | null;
  /**
   * The URL segment as the reader has it, which may carry a readable slug.
   *
   * Only ever used to send them back to where they were. Never looked up —
   * that is the token's job, and keeping the two apart is what stops a renamed
   * note breaking a link somebody already has.
   */
  segment?: string | null;
  /**
   * The short link this page was opened at, when it was opened at one.
   *
   * Present instead of a token, never beside one: a short link's token is
   * resolved on the server and deliberately never reaches this screen. What
   * this is for is the two things the screen cannot do without an address —
   * refusing when there is none, and building the URL to come back to after a
   * sign-in.
   */
  shortLink?: ShortLinkAddress | null;
  auth: { isLoading: boolean; isAuthenticated: boolean };
  /** `undefined` while in flight, an `Error` when the action refused. */
  note: ShareResult;
  /** The note the reader asked for, or `null` for the share's entry note. */
  requestedPath: string | null;
}

/**
 * Whether the server said the caller has no usable session.
 *
 * The `instanceof` and the shape check are both load-bearing, for
 * `toFileError`'s reason: reading `.code` off anything would let any object
 * carrying that property route a reader to sign-in, and trusting the wrapper
 * without inspecting it would do the same for a `ConvexError` holding a bare
 * string. Anything this does not recognise is a refusal, which is the
 * direction that discloses less.
 */
export function isNotAuthenticated(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  const data = error.data as { code?: unknown } | undefined;
  return data?.code === "NOT_AUTHENTICATED";
}

export type ShareView =
  /** Auth has not resolved. Paint the ground, decide nothing. */
  | { kind: "wait" }
  | { kind: "signIn"; href: string }
  | { kind: "loading" }
  /**
   * One screen for every refusal. See the module comment — the server
   * deliberately cannot tell these apart and neither may this.
   */
  | { kind: "unavailable" }
  | {
      kind: "ready";
      note: SharedNote;
      /** True when the reader is on a note reached *from* the entry note. */
      awayFromEntry: boolean;
    };

/**
 * The sign-in URL that comes back to the address the reader is actually on.
 *
 * Two addresses reach this screen and only one of them is in the URL bar at a
 * time, so the `next` has to be built from whichever one it was. Getting this
 * wrong is not cosmetic: a short link's reader sent to `/s/<token>` afterwards
 * would be handed a URL carrying the capability, which is the one thing the
 * short-link path exists to keep server-side.
 */
function signInBackTo(inputs: ShareInputs): string {
  const shortLink = inputs.shortLink ?? null;
  if (shortLink !== null) {
    return loginHref(shortLinkHref(shortLink, inputs.requestedPath ?? undefined));
  }
  return shareSignInHref(
    inputs.segment ?? inputs.token,
    inputs.requestedPath ?? undefined,
  );
}

export function resolveShareView(inputs: ShareInputs): ShareView {
  if (inputs.auth.isLoading) return { kind: "wait" };

  // Somebody opened `/s/` with nothing after it, or `/@name/<not a name>`.
  // The same screen a spent token gets: this page never confirms that any
  // particular token — or any particular name — exists.
  const shortLink = inputs.shortLink ?? null;
  if (inputs.token === null && shortLink === null) return { kind: "unavailable" };

  if (inputs.note instanceof Error) {
    // The one code this screen reads. See the module comment.
    if (isNotAuthenticated(inputs.note)) {
      return {
        kind: "signIn",
        href: signInBackTo(inputs),
      };
    }
    return { kind: "unavailable" };
  }
  if (inputs.note === undefined) return { kind: "loading" };

  // A note is on screen. If reading it needed a session and there is no longer
  // one, it is withdrawn — see the module comment. An unlisted link never had
  // one to lose.
  if (!inputs.note.openToAnyone && !inputs.auth.isAuthenticated) {
    return { kind: "signIn", href: signInBackTo(inputs) };
  }

  return {
    kind: "ready",
    note: inputs.note,
    awayFromEntry: inputs.note.path !== inputs.note.entryPath,
  };
}

/**
 * How a linked note is offered to the reader.
 *
 * The server returns paths; a reader wants names. The filename is what an
 * author actually chose, so it is what gets shown — the same reasoning as
 * `titleFromPath` on the card, and deliberately not the folder, which is filing
 * rather than title.
 */
export function linkLabel(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  const words = base
    .replace(/^\d+[-_.\s]+/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // A name with no letters in it is a filing code, not a title — a
  // date-stamped capture leaves "08 29" once its prefix is stripped, and a
  // button labelled that tells the reader nothing. The path at least says
  // where the note lives. Same judgement `titleFromPath` makes for the card.
  if (words === "" || !/[a-z]/i.test(words)) return path;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The links worth offering, excluding the note being read.
 *
 * A note that links to itself, or the entry note's own path appearing in its
 * link list, would otherwise render a button that goes nowhere the reader is
 * not already.
 */
export function onwardLinks(note: SharedNote): string[] {
  return note.links.filter((link) => link !== note.path);
}
