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
  if (owned === undefined || workspaces === undefined || invitations === undefined) {
    return undefined;
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
}: {
  /** Personal contexts owned, or `undefined` while the list is outstanding. */
  owned: number | undefined;
  /** True once `createWorkspace` has returned in this session. */
  claimed: boolean;
}): RouteDecision {
  // Mid-flow. `owned` is 1 *because of* step 1.
  if (claimed) return { action: "render" };
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
