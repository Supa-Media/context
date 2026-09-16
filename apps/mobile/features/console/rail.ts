/**
 * How the rail lists the contexts a person can reach.
 *
 * **One list, with the person's own workspace pinned to the top of it.** The
 * rail used to draw two headed groups, BRAINS and WORKSPACES, splitting on
 * `kind`. That split was the shape of a vocabulary that no longer exists: a
 * "brain" was only ever a workspace one person owns, and the owner retired the
 * word (2026-09-13, `docs/decisions/vocabulary-and-workspaces.md`). Once both
 * kinds are called the same thing, a heading over each of them is a division
 * with nothing to divide — two words for one noun, drawn as structure.
 *
 * What the split was genuinely carrying survives, in the two places that can
 * carry it more cheaply:
 *
 *  - **Whose notes am I about to open?** `@sayo` already says whose the row
 *    is, and the one row that is *yours* is pinned first and marked "yours".
 *    Exactly one row can ever carry that mark — `createWorkspace` writes one
 *    personal context per person and there is no transfer path — which is what
 *    makes a marker the right shape for it and a section the wrong one.
 *  - **Personal or shared?** Ownership of a *shared* workspace is deliberately
 *    still not marked: it is shared by construction, and what differs is your
 *    role in it, which is four states on the members card rather than one bit
 *    in a switcher.
 *
 * The pin is a pin and not a sort. Everything after the first row keeps the
 * order the control plane sent, so the list is stable and muscle memory works.
 *
 * The group is unconditional now, where each of the two used to survive an
 * empty list only while it still had something to offer. With one group there
 * is nothing its absence could say: it is where "Nothing here yet" lands for
 * an account with nothing at all, and where both offers — "Claim your @name"
 * and "New workspace" — hang.
 */

import type { ConsoleContext } from "./types";

/**
 * Is this the pinned context — `@context-lc`, which everybody reaches and
 * nobody joined?
 *
 * Read off the flag the control plane sets, never off the slug. The rail must
 * not be a second place that decides which name is special: the control plane
 * already answered that, and a client-side name comparison would go on drawing
 * the mark after the row stopped being pinned.
 */
export function isPinnedContext(context: ConsoleContext): boolean {
  return context.pinned === true;
}

export interface RailGroup {
  heading: string;
  /**
   * The contexts, own personal workspace first and the pinned one last.
   *
   * One list still, because the pin is not a second *section* — see the header
   * for why the headed groups went away and did not come back. What separates
   * it is the position, a hairline, and the mark the row carries; those are
   * `ConsoleRail`'s to draw, and this decides only the order.
   */
  contexts: ConsoleContext[];
  /**
   * The pinned context, if this person has one in the list.
   *
   * Named rather than left to be re-found, for the reason `ownWorkspace` is
   * exported: "there is at most one" is a claim worth stating in one place, and
   * the rail needs it twice — once to know where to draw the rule, and once to
   * decide the row's own mark and menu.
   */
  pinned: ConsoleContext | null;
  /**
   * Whether to draw the "Claim your @name" entry, which takes the **pinned
   * top slot** — it is the placeholder for exactly the row that would be
   * there. It is drawn accented, because the person it is for arrived through
   * somebody else's invitation and has no reason to suspect the product does
   * anything else, and it stops existing the moment it is used.
   */
  claim: boolean;
  /**
   * Whether to draw the "New workspace" entry, at the **foot** of the list.
   *
   * Separate from `claim` rather than folded into it because the two are true
   * at different times and are drawn differently. This is an ordinary verb
   * that is true from the first session and stays true, so it is drawn quietly
   * — an accent on it would be an advertisement on every screen of every
   * session.
   */
  create: boolean;
}

/**
 * Is this row the signed-in person's own workspace?
 *
 * Both halves are required and neither is sufficient. `kind === "personal"`
 * alone is any personal workspace, including one somebody shared with you;
 * `role === "owner"` alone includes every shared workspace you created.
 * Exactly one context can satisfy both, because `createWorkspace` writes one
 * personal context per person and there is no transfer path — which is the
 * property that lets this be a mark on a row and a pin of one row.
 */
export function isOwnWorkspace(context: ConsoleContext): boolean {
  return context.kind === "personal" && context.role === "owner";
}

/**
 * The person's own workspace, or `null`.
 *
 * Exported because the rail is not the only surface that wants it, and because
 * "there is at most one" is a claim worth stating in one place rather than
 * re-deriving with a `.filter()[0]` at each call site.
 */
export function ownWorkspace(
  contexts: readonly ConsoleContext[],
): ConsoleContext | null {
  return contexts.find(isOwnWorkspace) ?? null;
}

/**
 * The pinned context in this list, or `null`.
 *
 * At most one, for a stronger reason than `ownWorkspace`'s: the control plane
 * appends exactly one row with the flag and skips it entirely when a real
 * membership already covers that workspace, so a second one would be a bug
 * upstream rather than a case to handle here. `find` rather than a filter says
 * that.
 */
export function pinnedContext(
  contexts: readonly ConsoleContext[],
): ConsoleContext | null {
  return contexts.find(isPinnedContext) ?? null;
}

export function railGroup({
  contexts,
  claimable,
  creatable = false,
}: {
  contexts: readonly ConsoleContext[];
  /** Whether the "Claim your @name" entry is being offered. */
  claimable: boolean;
  /**
   * Whether the "New workspace" entry is being offered. Defaults to `false` so
   * the landing page's picture of the rail — which has nowhere to send anybody
   * — keeps rendering without it.
   */
  creatable?: boolean;
}): RailGroup {
  const own = ownWorkspace(contexts);
  const pinned = pinnedContext(contexts);
  /*
    Your own workspace first, the pinned context last, and everything else in
    the order it arrived. `filter` is stable, so both ends are pins rather than
    a sort: the control plane decides the rest of the order and this does not
    second-guess it.

    The pinned row is held to the end here as well as sent last by the control
    plane, and that is not redundant. The order this receives is the transport's
    and a client that is one deploy behind, or a list the console has merged
    from a cache, can present it in any order at all — and the separation the
    rail draws is *positional*, so a hairline above a row that is not last is
    a rule through the middle of somebody's workspaces.
  */
  const ordered = [
    ...(own === null ? [] : [own]),
    ...contexts.filter((context) => context !== own && context !== pinned),
    ...(pinned === null ? [] : [pinned]),
  ];

  return {
    heading: "Workspaces",
    contexts: ordered,
    pinned,
    // The claim entry occupies the pinned slot, so it cannot be offered beside
    // the row it stands in for. `offerOwnContext` already counts owned
    // personal contexts before asking; this is the second lock, in the one
    // place that knows what is about to be drawn in that slot.
    claim: claimable && own === null,
    create: creatable,
  };
}
