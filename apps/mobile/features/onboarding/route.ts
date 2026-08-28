/**
 * Where a brand-new account is allowed to be.
 *
 * Signing in creates an account, not a context. Until someone claims a name
 * there is nothing to browse, nothing to connect a bucket to, and no rail entry
 * to click — so the console is a dead end rather than an empty state. These
 * rules route around that, and they are pure functions for the same reason
 * `features/auth/redirect.ts` and `features/console/nav.ts` are: a redirect
 * rule looks right when you click it and is wrong when somebody reloads.
 *
 * ## The distinction this file exists to protect
 *
 * **A query that has not resolved is not "nothing".** `listMyWorkspaces` is
 * `undefined` while its first round trip is outstanding, and treating that as
 * an empty list would bounce an established user into onboarding on every cold
 * load — the same "not loaded yet ≠ not yours" bug `resolveContextRoute`
 * already guards against. Every function here takes its standing as
 * `ContextStanding | undefined` and branches on `undefined` first.
 *
 * ## Why counting contexts was the wrong question
 *
 * Both gates used to take one number — how many workspaces `listMyWorkspaces`
 * returned — and it turns out they are asking different questions, which is
 * exactly why one number could not answer both. Somebody invited into another
 * person's context breaks the old rule in both directions at once:
 *
 *  - Before they accept they have **zero** workspaces, so the `(app)` gate sent
 *    them to `/welcome` and they never saw the invitation that brought them
 *    here. The whole point of an invitation is that the app is not empty; the
 *    gate made it empty.
 *  - The moment they accept they have **one**, so the welcome screen's gate
 *    redirected them to the console — permanently. Onboarding is not
 *    re-runnable, and they had never run it, so they could never claim a name,
 *    connect a bucket, or own anything. Being given a context locked them out
 *    of having one.
 *
 * So the gates now ask what they actually mean. The `(app)` gate asks *is
 * there anything here for you* — a context you can open, or an invitation you
 * can answer. The welcome gate asks *have you already run this* — which is a
 * question about contexts you **own**, because owning a personal context is
 * the thing this flow produces and the thing it must not produce twice.
 *
 * ## Why the rule is split in two
 *
 *  - `needsOnboarding` — the `(app)` layout's gate. "Nothing here for you, so
 *    go somewhere that has something." It never redirects *away* from the
 *    destinations it sends people to.
 *  - `resolveWelcomeRoute` — the screen's own gate. "You already own a
 *    context, so there is nothing to run." It knows whether a name was claimed
 *    *in this session*.
 *
 * That last clause is load-bearing. The moment `createWorkspace` returns,
 * `listMyWorkspaces` pushes down a list of length one — so a single "owns a
 * context → console" rule would eject the user out of step 2 the instant they
 * finished step 1, mid-flow, into a console with no bucket connected. `claimed`
 * is what keeps them in the flow they are standing in.
 */

import {
  CONSOLE_ROUTE,
  INVITE_ROUTE,
  isInvitePath,
  type RouteDecision,
} from "../auth/redirect";

export const WELCOME_ROUTE = "/welcome";

/**
 * What this account has, as the gates need to see it.
 *
 * Three numbers rather than one, because the two gates ask different questions
 * and a single count answers neither correctly for somebody who was invited.
 * Derived in `standingFrom` so the derivation is tested once rather than
 * written out at each call site.
 */
export interface ContextStanding {
  /**
   * Personal contexts this account **owns**. Onboarding creates exactly one,
   * so this is the only honest answer to "has this flow already run".
   */
  owned: number;
  /**
   * Every context this account can open — its own and other people's. This is
   * what decides whether the console has anything to show.
   */
  reachable: number;
  /** Invitations addressed to this account and still answerable. */
  invitations: number;
}

/** One row of `listMyWorkspaces`, narrowed to what the gates read. */
export interface WorkspaceStandingRow {
  kind: string;
  role: string;
}

/**
 * How many personal contexts this account owns — the only question the welcome
 * screen's gate asks.
 *
 * Split out from `standingFrom` so that gate can be answered from the workspace
 * list alone. Making it take a whole standing would oblige the onboarding
 * controller to subscribe to invitations as well, for a number it never reads.
 */
export function ownedContexts(
  workspaces: readonly WorkspaceStandingRow[] | undefined,
): number | undefined {
  if (workspaces === undefined) return undefined;
  return workspaces.filter((w) => w.kind === "personal" && w.role === "owner").length;
}

/**
 * Should the console offer to create this person a context of their own?
 *
 * The gap this closes is the other half of the bug the two gates above fix.
 * `needsOnboarding` deliberately *renders* for somebody who can reach a
 * context they do not own — being sent to "claim your name" instead of the
 * invitation that brought them here throws away the referral, and it says so:
 * "prompting them to build their own belongs on a banner rather than in a
 * redirect." There was then no banner, and no rail entry, and no route to
 * `/welcome` from anywhere inside the app. Somebody invited into another
 * person's context could read it and could not discover that having one of
 * their own was a thing the product did.
 *
 * `/welcome` itself was always ready for them — `resolveWelcomeRoute` asks
 * about contexts **owned**, so it renders for an invitee at zero. Only the way
 * in was missing.
 *
 * Two things this must not do:
 *
 *  - **Offer it while the list is loading.** `undefined` is not "owns
 *    nothing", and a "claim your name" that appears for a moment on every cold
 *    load in front of somebody who has had a context for a year is the same
 *    class of mistake as redirecting them to onboarding.
 *  - **Offer it to somebody who already owns one.** Onboarding is not
 *    re-runnable and `createWorkspace` writes exactly one personal context;
 *    the entry would lead to a screen that redirects straight back.
 */
export function offerOwnContext({
  contexts,
  loading,
}: {
  /** The console's context list, or `undefined` before it lands. */
  contexts: readonly WorkspaceStandingRow[] | undefined;
  /** True while the first round trip is outstanding. */
  loading: boolean;
}): boolean {
  if (loading) return false;
  const owned = ownedContexts(contexts);
  if (owned === undefined) return false;
  return owned === 0;
}

/**
 * Turn the two subscriptions into a standing, or `undefined` if either is
 * still outstanding.
 *
 * **Both must have landed.** A standing built from a resolved workspace list
 * and an unresolved invitation list says `invitations: 0`, which is the exact
 * shape of "send this person to onboarding" — so an invitee whose invitation
 * query is a few milliseconds slower than their workspace query would be
 * bounced anyway, intermittently, which is the worst way to have this bug.
 */
export function standingFrom(
  workspaces: readonly WorkspaceStandingRow[] | undefined,
  invitations: readonly unknown[] | undefined,
): ContextStanding | undefined {
  const owned = ownedContexts(workspaces);
  if (owned === undefined || workspaces === undefined) return undefined;

  if (invitations === undefined) {
    // The workspace list has landed and the invitation list has not — either
    // still in flight, or failing. Waiting is right for the first and a trap
    // for the second: `usable()` maps a persistent query error to `undefined`
    // too, so a control plane that does not answer `listMyInvitations` at all
    // (a rollback, a partial deploy, an older self-hosted backend) would leave
    // this permanently unresolved, and an unresolved standing renders. A
    // brand-new account would sit in a console with nothing in it and no route
    // to `/welcome` — exactly the dead end that does not look like one this
    // module exists to prevent, made worse than before the invitation list was
    // consulted at all.
    //
    // So there is one case worth answering without it: somebody who can reach
    // **nothing**. Sending them to `/welcome` costs an invitee one hop —
    // claiming a name does not spend or hide an invitation, and `/invite` is
    // still there once the query recovers — while leaving them in an empty
    // console costs them the product. Anybody with a context to open is
    // rendered as before, because the invitation count cannot change that.
    if (workspaces.length > 0) return undefined;
    return { owned, reachable: 0, invitations: 0 };
  }

  return { owned, reachable: workspaces.length, invitations: invitations.length };
}

/** Is this URL the onboarding flow? Query and hash are not part of the answer. */
export function isWelcomePath(pathname: string): boolean {
  const trimmed = pathname.split("?")[0]!.split("#")[0]!.replace(/\/+$/, "");
  return trimmed === WELCOME_ROUTE;
}

/**
 * The `(app)` group's onboarding gate, applied on top of the auth gate.
 *
 * Renders — never redirects — while the standing is still loading. A brief
 * console shell that then fills in is a non-event; a signed-in user thrown into
 * onboarding because their own contexts had not arrived yet is not.
 *
 * The order of the three answers is the whole rule:
 *
 *  1. **Anything reachable → render.** One context is enough, and it does not
 *     have to be yours. Somebody reading a context they were given is exactly
 *     where they should be, and prompting them to build their own belongs on a
 *     banner rather than in a redirect.
 *  2. **Otherwise, a pending invitation → `/invite`.** This is the case the
 *     old rule got wrong. They have nothing yet, but they were sent here by
 *     somebody, and the invitation is the reason they opened the app at all.
 *     Sending them to "claim your name" instead throws away the entire
 *     referral.
 *  3. **Otherwise → `/welcome`.** A genuinely empty account, which is what the
 *     original rule was written for.
 */
export function needsOnboarding({
  standing,
  pathname,
}: {
  /** `undefined` while either subscription is outstanding. */
  standing: ContextStanding | undefined;
  pathname: string;
}): RouteDecision {
  if (standing === undefined) return { action: "render" };
  // Both destinations answer for themselves; redirecting to a path somebody is
  // already standing on is how you write a loop.
  if (isWelcomePath(pathname)) return { action: "render" };
  if (isInvitePath(pathname)) return { action: "render" };

  if (standing.reachable > 0) return { action: "render" };
  if (standing.invitations > 0) return { action: "redirect", href: INVITE_ROUTE };
  return { action: "redirect", href: WELCOME_ROUTE };
}

/**
 * The welcome screen's own gate.
 *
 * `claimed` means a context was created during *this* run of the flow, which
 * is the one case where owning a context must not send you to the console.
 */
export function resolveWelcomeRoute({
  owned,
  claimed,
  resuming = false,
}: {
  /** Personal contexts owned, or `undefined` while the list is outstanding. */
  owned: number | undefined;
  /** True once `createWorkspace` has returned in this session. */
  claimed: boolean;
  /**
   * True when the URL carries `resume=structure` — a Dropbox connect started
   * inside this flow, left for the OAuth redirect, and came back. The person
   * *does* own a context now, because step 1 ran before they left; bouncing
   * them to the console is how the first live run lost its layout and agents
   * steps. Not a way to re-run onboarding at large: it enters at the layout
   * step, whose writes are owner-gated and refuse an unverified binding.
   */
  resuming?: boolean;
}): RouteDecision {
  // Mid-flow. `owned` is 1 *because of* step 1.
  if (claimed) return { action: "render" };
  if (resuming) {
    if (owned === undefined) return { action: "wait" };
    // Resuming is only meaningful for somebody the flow half-ran for. A
    // visitor who owns nothing typed the param; give them onboarding proper.
    return { action: "render" };
  }
  // Not "owns nothing" — unknown. Deciding now is how you get a flash of
  // onboarding in front of somebody who has three contexts.
  if (owned === undefined) return { action: "wait" };
  // Onboarding is not re-runnable: a second personal context is not a thing
  // you are allowed to have, and this flow only ever creates one. Note this
  // counts contexts *owned*, not contexts reachable — somebody who has been
  // given access to another person's context has not run this flow and must
  // still be able to.
  if (owned === 0) return { action: "render" };
  return { action: "redirect", href: CONSOLE_ROUTE };
}
