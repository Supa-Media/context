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

import { loginHref } from "../auth/redirect";

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
 * A route parameter that may arrive as an array.
 *
 * Expo Router hands back `string[]` when a segment repeats — `/s/a/b` — and a
 * bare `string` assumption is how that becomes a crash rather than a refusal.
 */
export function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.length > 0 ? (value[0] ?? null) : null;
  return value ?? null;
}

/** What `readSharedNote` returns, mirrored so this module needs no Convex. */
export interface SharedNote {
  path: string;
  text: string;
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

export function resolveShareView(inputs: ShareInputs): ShareView {
  if (inputs.auth.isLoading) return { kind: "wait" };

  // Somebody opened `/s/` with nothing after it. The same screen a spent token
  // gets: this page never confirms that any particular token exists.
  if (inputs.token === null) return { kind: "unavailable" };

  if (inputs.note instanceof Error) {
    // The one code this screen reads. See the module comment.
    if (isNotAuthenticated(inputs.note)) {
      return {
        kind: "signIn",
        href: shareSignInHref(
          inputs.segment ?? inputs.token,
          inputs.requestedPath ?? undefined,
        ),
      };
    }
    return { kind: "unavailable" };
  }
  if (inputs.note === undefined) return { kind: "loading" };

  // A note is on screen. If reading it needed a session and there is no longer
  // one, it is withdrawn — see the module comment. An unlisted link never had
  // one to lose.
  if (!inputs.note.openToAnyone && !inputs.auth.isAuthenticated) {
    return {
      kind: "signIn",
      href: shareSignInHref(
        inputs.segment ?? inputs.token,
        inputs.requestedPath ?? undefined,
      ),
    };
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
