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
 * **A query that has not resolved is not "zero contexts".** `listMyWorkspaces`
 * is `undefined` while its first round trip is outstanding, and treating that
 * as an empty list would bounce an established user into onboarding on every
 * cold load — the same "not loaded yet ≠ not yours" bug `resolveContextRoute`
 * already guards against. Every function here takes `contextCount` as
 * `number | undefined` and branches on `undefined` first.
 *
 * ## Why the rule is split in two
 *
 * The gate and the screen ask different questions, and folding them into one
 * predicate breaks the flow in a way that is easy to miss:
 *
 *  - `needsOnboarding` — the `(app)` layout's gate. "Zero contexts, so go to
 *    `/welcome`." It never redirects *away* from `/welcome`.
 *  - `resolveWelcomeRoute` — the screen's own gate. "You already have a
 *    context, so there is nothing to run." It knows whether a name was claimed
 *    *in this session*.
 *
 * That second clause is load-bearing. The moment `createWorkspace` returns,
 * `listMyWorkspaces` pushes down a list of length one — so a single "has
 * contexts → console" rule would eject the user out of step 2 the instant they
 * finished step 1, mid-flow, into a console with no bucket connected. `claimed`
 * is what keeps them in the flow they are standing in.
 */

import { CONSOLE_ROUTE, type RouteDecision } from "../auth/redirect";

export const WELCOME_ROUTE = "/welcome";

/** Is this URL the onboarding flow? Query and hash are not part of the answer. */
export function isWelcomePath(pathname: string): boolean {
  const trimmed = pathname.split("?")[0]!.split("#")[0]!.replace(/\/+$/, "");
  return trimmed === WELCOME_ROUTE;
}

/**
 * The `(app)` group's onboarding gate, applied on top of the auth gate.
 *
 * Renders — never redirects — while the context list is still loading. A brief
 * console shell that then fills in is a non-event; a signed-in user thrown into
 * onboarding because their own contexts had not arrived yet is not.
 */
export function needsOnboarding({
  contextCount,
  pathname,
}: {
  /** `undefined` while `listMyWorkspaces` is outstanding. */
  contextCount: number | undefined;
  pathname: string;
}): RouteDecision {
  if (contextCount === undefined) return { action: "render" };
  // `/welcome` answers for itself; see `resolveWelcomeRoute`.
  if (isWelcomePath(pathname)) return { action: "render" };
  if (contextCount === 0) return { action: "redirect", href: WELCOME_ROUTE };
  return { action: "render" };
}

/**
 * The welcome screen's own gate.
 *
 * `claimed` means a context was created during *this* run of the flow, which
 * is the one case where having contexts must not send you to the console.
 */
export function resolveWelcomeRoute({
  contextCount,
  claimed,
}: {
  contextCount: number | undefined;
  /** True once `createWorkspace` has returned in this session. */
  claimed: boolean;
}): RouteDecision {
  // Mid-flow. The list is length one *because of* step 1.
  if (claimed) return { action: "render" };
  // Not "zero contexts" — unknown. Deciding now is how you get a flash of
  // onboarding in front of somebody who has three contexts.
  if (contextCount === undefined) return { action: "wait" };
  if (contextCount === 0) return { action: "render" };
  // Onboarding is not re-runnable: a second personal context is not a thing
  // you are allowed to have, and this flow only ever creates one.
  return { action: "redirect", href: CONSOLE_ROUTE };
}
