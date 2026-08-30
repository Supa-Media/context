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
 */

import { loginHref } from "../auth/redirect";

/** Where a shared note lives. Must match `SHARE_PATH_PREFIX` in the console. */
export const SHARE_ROUTE = "/s";

/**
 * `/s/<token>`, and `/s/<token>?path=…` for a note reached from it.
 *
 * The token is a path segment and the note is a query parameter, which is the
 * right way round: the token names *what you have access to* and the path names
 * *where you are inside it*. A reader who edits the query gets a refusal from
 * the server, never a different share.
 */
export function shareHref(token: string, path?: string): string {
  const base = `${SHARE_ROUTE}/${encodeURIComponent(token)}`;
  return path === undefined ? base : `${base}?path=${encodeURIComponent(path)}`;
}

/** The sign-in URL that comes back here afterwards. */
export function shareSignInHref(token: string | null, path?: string): string {
  // A missing token still goes to sign-in rather than to a dead end: the reader
  // has no way to fix the URL, and a signed-in reader at least lands somewhere
  // that explains itself.
  return loginHref(token === null ? null : shareHref(token, path));
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
}

export type ShareResult = SharedNote | Error | undefined;

export interface ShareInputs {
  token: string | null;
  auth: { isLoading: boolean; isAuthenticated: boolean };
  /** `undefined` while in flight, an `Error` when the action refused. */
  note: ShareResult;
  /** The note the reader asked for, or `null` for the share's entry note. */
  requestedPath: string | null;
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
  if (!inputs.auth.isAuthenticated) {
    return {
      kind: "signIn",
      href: shareSignInHref(inputs.token, inputs.requestedPath ?? undefined),
    };
  }

  // Somebody opened `/s/` with nothing after it. The same screen a spent token
  // gets: this page never confirms that any particular token exists.
  if (inputs.token === null) return { kind: "unavailable" };

  if (inputs.note instanceof Error) return { kind: "unavailable" };
  if (inputs.note === undefined) return { kind: "loading" };

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
