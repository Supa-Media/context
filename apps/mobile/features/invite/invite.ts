/**
 * What the invitation screens show, as pure functions of what they know.
 *
 * Same shape and the same reasoning as `features/consent/state.ts`: a redirect
 * rule looks right when you click it and is wrong when somebody reloads, so
 * every rule here is an exported function with a test rather than an `if` inside
 * a component nobody can mount.
 *
 * Three rules are encoded here rather than left to the screens.
 *
 * **1. A dead token is one message, whatever killed it.** `acceptInvitation`
 * throws a single `INVITATION_NOT_FOUND` for "no such invitation", "not yours",
 * "already answered" and "expired" — see the `invitationNotFound()` docstring
 * in `apps/convex/functions/invitations.ts`, where the reasoning is spelled
 * out: a token is the only handle on an invitation, so an error distinguishing
 * "real but addressed to somebody else" from "never existed" confirms a guessed
 * token, and one distinguishing "already accepted" from "unknown" turns a spent
 * invitation into a probe. The screen must not helpfully un-collapse that.
 *
 * The mechanism that keeps it honest is worth stating: there is no
 * "get invitation by token" query, and there must not be one. The screen looks
 * its token up in `listMyInvitations` — the caller's *own* pending list — so
 * all four causes arrive as the same absence before any copy is chosen. The
 * only way to reintroduce the distinction is to add a query that answers
 * questions about somebody else's invitation.
 *
 * **2. A failed subscription is not a dead invitation.** `unavailable` is its
 * own view. Telling somebody their link is spent because the socket dropped is
 * unrecoverable — the link is in an email they may never open again — and the
 * disclosure argument does not apply, because a query failure says nothing
 * about the token.
 *
 * **3. A decision outranks the list.** Accepting and declining both spend the
 * invitation, so the row leaves `listMyInvitations` moments later. Resolving the
 * list first would tell the person who just declined that their link was never
 * valid. The decision is therefore checked before anything else, exactly as
 * `resolveConsentView` checks `leaving` first.
 */

import { INVITE_ROUTE, loginHref, inviteHref } from "../auth/redirect";
import { browseHref } from "../console/nav";
import { atName } from "../console/format";
import { describeRole, errorCodeOf, expiryLabel } from "../console/members/members";

/** One row of `listMyInvitations`, which returns pending invitations and nothing else. */
export interface PendingInvitation {
  /** Single-use, expiring, and useless to anybody who is not the invitee. */
  token: string;
  workspaceId: string;
  slug: string;
  displayName: string;
  role: string;
  /** An opaque user id. Deliberately never rendered — see `invitationLede`. */
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * The subscription's result, as `useQueries` reports it: `undefined` in flight,
 * `Error` when the query threw, otherwise the list.
 */
export type InvitationsResult = readonly PendingInvitation[] | Error | undefined;

export interface InviteError {
  headline: string;
  next?: string;
}

/** What the person is part-way through doing on the single-invitation screen. */
export type InviteDecision =
  | { kind: "idle"; error?: InviteError }
  | { kind: "submitting"; choice: "accept" | "decline" }
  /** Accepted. `slug` is what the backend said we joined, not what we guessed. */
  | { kind: "accepted"; slug: string }
  | { kind: "declined" };

export type InviteView =
  /** Auth is still resolving. Render nothing rather than flashing a screen. */
  | { kind: "wait" }
  /** Signed out. The token rides along in `next` so the link survives sign-in. */
  | { kind: "signIn"; href: string }
  /** Signed in; the invitation list is still in flight. */
  | { kind: "loading" }
  /** The list came back as an error. Not a verdict on the token. */
  | { kind: "unavailable" }
  /** The one message every unusable token gets. */
  | { kind: "dead"; headline: string; detail: string }
  | {
      kind: "ready";
      invitation: PendingInvitation;
      busy: null | "accept" | "decline";
      error?: InviteError;
    }
  /** Accepted. The context is theirs to open. */
  | { kind: "joined"; slug: string; href: string }
  | { kind: "declined" };

export interface InviteInputs {
  /** The `[token]` path segment. `null` when it is missing or malformed. */
  token: string | null;
  auth: { isLoading: boolean; isAuthenticated: boolean };
  invitations: InvitationsResult;
  decision: InviteDecision;
  now: number;
}

/**
 * The one message an unusable token gets.
 *
 * A frozen object rather than a function, so "was this the expired copy or the
 * spent copy" is not a question anybody can ask of this file. There is one.
 *
 * It names the *class* of thing — links here are single-use and expire — which
 * is a published property of the product, and says nothing about this token.
 */
export const INVITATION_DEAD: { headline: string; detail: string } = Object.freeze({
  headline: "This invitation link doesn't work",
  detail:
    "Invitation links are single-use, expire after a week, and only work for the person they were sent to. Ask whoever invited you to send a new one.",
});

/**
 * Expo Router hands back `string | string[]` for a parameter, and `undefined`
 * when it is absent.
 *
 * An emailed invitation URL can also carry `?code=`, which `ConvexAuthProvider`
 * consumes and strips before any of this renders. Nothing here depends on that,
 * but nothing here assumes a bare string either: a duplicated segment arrives
 * as an array, and `value.length > 0` is what stops an empty segment being
 * treated as a token that merely does not exist.
 */
export function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

/**
 * Where a signed-out visitor goes, and what brings them back.
 *
 * The token is the whole point. It exists in one email and nowhere else, no
 * rail entry reproduces it, and `/login` on its own would drop it — which is
 * why `resolveProtectedRoute` learned to carry an attempted path at all.
 * `loginHref` narrows the target through `safeNextRoute` on the way out and
 * `resolveAuthRoute` narrows it again on the way back.
 */
export function signInHref(token: string | null): string {
  return loginHref(token === null ? INVITE_ROUTE : inviteHref(token));
}

/** The invitations still answerable right now, oldest first. */
export function stillPending(
  invitations: readonly PendingInvitation[],
  now: number,
): PendingInvitation[] {
  // The backend filters expired rows too. This filters again because a screen
  // can sit open past an expiry, and an Accept button that is certain to fail
  // is worse than a row that has quietly gone.
  return invitations
    .filter((invitation) => invitation.expiresAt > now)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * The caller's own invitation with this token, if they have one.
 *
 * `null` covers every reason there is not one, and the caller cannot tell them
 * apart because this function cannot either.
 */
export function findInvitation(
  invitations: readonly PendingInvitation[],
  token: string,
  now: number,
): PendingInvitation | null {
  return stillPending(invitations, now).find((row) => row.token === token) ?? null;
}

export function resolveInviteView(inputs: InviteInputs): InviteView {
  // Rule 3: the decision outranks the list it is about to empty.
  if (inputs.decision.kind === "accepted") {
    const slug = inputs.decision.slug;
    return { kind: "joined", slug, href: browseHref(slug) };
  }
  if (inputs.decision.kind === "declined") return { kind: "declined" };

  if (inputs.auth.isLoading) return { kind: "wait" };
  if (!inputs.auth.isAuthenticated) {
    return { kind: "signIn", href: signInHref(inputs.token) };
  }

  // Somebody opened `/invite/` with nothing after it. Same message as a token
  // that was spent an hour ago: this screen never confirms that any particular
  // token exists.
  if (inputs.token === null) return { ...INVITATION_DEAD, kind: "dead" };

  if (inputs.invitations instanceof Error) return { kind: "unavailable" };
  if (inputs.invitations === undefined) return { kind: "loading" };

  const invitation = findInvitation(inputs.invitations, inputs.token, inputs.now);
  if (invitation === null) return { ...INVITATION_DEAD, kind: "dead" };

  return {
    kind: "ready",
    invitation,
    busy: inputs.decision.kind === "submitting" ? inputs.decision.choice : null,
    error: inputs.decision.kind === "idle" ? inputs.decision.error : undefined,
  };
}

/* -------------------------------------------------------------------------- *
 * The bare `/invite` list.
 * -------------------------------------------------------------------------- */

export type InviteListDecision =
  | { kind: "idle"; error?: InviteError }
  | { kind: "submitting"; token: string; choice: "accept" | "decline" }
  | { kind: "accepted"; slug: string };

export type InviteListView =
  | { kind: "wait" }
  | { kind: "signIn"; href: string }
  | { kind: "loading" }
  | { kind: "unavailable" }
  /**
   * Nothing left to answer.
   *
   * Reached honestly: they answered the last one in another tab, or it expired
   * while the tab sat open. `needsOnboarding` sends an account with no contexts
   * and one pending invitation here, so this is the state where somebody
   * arrives at a page that was about to be the reason they signed up and finds
   * it blank. It is a screen with a way on, not an empty list.
   */
  | { kind: "empty" }
  | {
      kind: "list";
      invitations: PendingInvitation[];
      busy: { token: string; choice: "accept" | "decline" } | null;
      error?: InviteError;
    }
  | { kind: "joined"; slug: string; href: string };

export function resolveInviteListView(inputs: {
  auth: { isLoading: boolean; isAuthenticated: boolean };
  invitations: InvitationsResult;
  decision: InviteListDecision;
  now: number;
}): InviteListView {
  if (inputs.decision.kind === "accepted") {
    const slug = inputs.decision.slug;
    return { kind: "joined", slug, href: browseHref(slug) };
  }

  if (inputs.auth.isLoading) return { kind: "wait" };
  if (!inputs.auth.isAuthenticated) return { kind: "signIn", href: signInHref(null) };

  if (inputs.invitations instanceof Error) return { kind: "unavailable" };
  if (inputs.invitations === undefined) return { kind: "loading" };

  const pending = stillPending(inputs.invitations, inputs.now);
  // Declining does not need a state of its own here: the row leaves the live
  // subscription, the list shrinks, and the last decline lands on `empty` —
  // which already knows how not to strand somebody.
  if (pending.length === 0) return { kind: "empty" };

  return {
    kind: "list",
    invitations: pending,
    busy:
      inputs.decision.kind === "submitting"
        ? { token: inputs.decision.token, choice: inputs.decision.choice }
        : null,
    error: inputs.decision.kind === "idle" ? inputs.decision.error : undefined,
  };
}

/* -------------------------------------------------------------------------- *
 * Copy.
 * -------------------------------------------------------------------------- */

/** "You've been invited to @ignite". */
export function invitationTitle(invitation: PendingInvitation): string {
  return `You've been invited to ${atName(invitation.slug)}`;
}

/**
 * The context, named the way a person would name it.
 *
 * `displayName` when it says something the slug does not; the handle alone when
 * it is the same word twice.
 */
export function contextLabel(invitation: PendingInvitation): string {
  const display = invitation.displayName.trim();
  const handle = atName(invitation.slug);
  if (display.length === 0 || display.toLowerCase() === invitation.slug.toLowerCase()) {
    return handle;
  }
  return `${display} (${handle})`;
}

/**
 * Who is offering, and what.
 *
 * It does not name the person who invited them, and that is a limitation rather
 * than a choice: `listMyInvitations` returns `invitedBy` as a bare user id with
 * no name or address attached. Rendering an opaque id would tell the reader
 * nothing and look like a bug — the same rule `memberLabel` follows — so the
 * sentence names the *context*, which is the thing being offered and the thing
 * they will see in their rail afterwards.
 */
export function invitationLede(invitation: PendingInvitation): string {
  return `Somebody who owns ${contextLabel(invitation)} added you to it. Accepting puts it in your console alongside your own.`;
}

/**
 * What the role hands over, built on `describeRole` so this sentence and the
 * members list cannot drift into disagreeing about what an editor is.
 */
export function acceptanceLine(role: string): string {
  return `${roleNoun(role)} — ${describeRole(role).toLowerCase()}.`;
}

/** "a member" / "an editor", or the raw role for a vocabulary we do not know. */
export function roleNoun(role: string): string {
  switch (role) {
    case "editor":
      return "An editor";
    case "member":
      return "A member";
    default:
      return role;
  }
}

/**
 * The terms of the link itself.
 *
 * Says the two things that decide whether somebody acts on this now: it runs
 * out, and it is theirs. Uses `expiryLabel` — the same coarse phrasing an owner
 * sees against the same invitation in their members list.
 */
export function invitationTerms(invitation: PendingInvitation, now: number): string {
  return `Single-use, and only you can use it. This one ${expiryLabel(invitation.expiresAt, now)}.`;
}

/**
 * A refusal from `acceptInvitation` or `declineInvitation`, turned into
 * something to read.
 *
 * `INVITATION_NOT_FOUND` gets `INVITATION_DEAD` verbatim, which is the same
 * copy the screen shows for a token that was never in the list — so an
 * invitation that expires between render and press reads identically to one
 * that expired last week. Everything else is a transport failure and says so
 * without diagnosing the token.
 */
export function describeInviteFailure(
  error: unknown,
  choice: "accept" | "decline",
): InviteError {
  switch (errorCodeOf(error)) {
    case "INVITATION_NOT_FOUND":
      return { headline: INVITATION_DEAD.headline, next: INVITATION_DEAD.detail };
    case "NOT_AUTHENTICATED":
      return {
        headline: "Your session ended while this page was open",
        next: "Sign in again and this link will still work.",
      };
    default:
      return {
        headline:
          choice === "accept"
            ? "Couldn't accept this invitation"
            : "Couldn't decline this invitation",
        next: "Nothing changed. Check your connection and try again.",
      };
  }
}
