/**
 * How the rail groups the contexts a person can reach.
 *
 * **The split is on kind — Brains and Workspaces — and it used to be on
 * ownership.** That earlier split ("Yours" / "Shared with you") was answering a
 * real question, *whose notes am I about to open?*, and it was answering it in
 * the wrong place. Two things were wrong with it:
 *
 *  - **It named neither of the product's nouns.** The vocabulary decision gives
 *    the two kinds two words — a **brain** is one person's context, a
 *    **workspace** is a shared one — and the rail is the one surface where a
 *    person meets both. Heading them "Yours" and "Shared with you" made the
 *    switcher the only place in the product that talks about contexts without
 *    using either word for them.
 *  - **For a brain, the row already answered it.** `@sayo` is Sayo's brain;
 *    nobody reads that row and wonders whose notes are behind it. The section
 *    boundary was spending the rail's strongest structural device on a fact the
 *    handle carries for free — and paying for it by scattering the workspaces,
 *    where whose-is-it is genuinely ambiguous, across both sections according
 *    to something the rail never showed.
 *
 * So ownership moves from a section boundary to a **mark on one row**:
 * `ownBrain` finds the single context that is this person's own brain, and it
 * is pinned first in its group and labelled. Exactly one row can ever carry it
 * — `createWorkspace` writes one personal context per person — which is what
 * makes a marker the right shape for it and a section the wrong one.
 *
 * Ownership of a *workspace* is deliberately not marked. A workspace is shared
 * by construction, the thing that differs is your role in it, and a role is
 * four states shown on the members card rather than one bit in a switcher.
 *
 * A section with nothing to show and nothing to offer is omitted, header and
 * all: a heading over nothing reads as something failing to load. Each section
 * survives an empty list only while it still has something to say — Brains
 * while it can offer "Claim your @name", Workspaces while it can offer "New
 * workspace" — and Brains is also where the "Nothing here yet" empty state of
 * an account with nothing at all lands.
 */

import type { ConsoleContext } from "./types";

export interface RailSection {
  key: "brains" | "workspaces";
  heading: string;
  contexts: ConsoleContext[];
  /**
   * The Brains section carries the "Claim your @name" entry.
   *
   * It belongs here rather than anywhere else because this group is the one
   * that raises the question it answers: a person looking at a list of brains,
   * none of which is theirs, is being shown the gap.
   */
  claim: boolean;
  /**
   * The Workspaces section carries the "New workspace" entry.
   *
   * Separate from `claim` rather than folded into it because the two are true
   * at different times and are drawn differently. `claim` is "you have no brain
   * of your own", which stops being true forever the moment it is used, and it
   * is drawn accented because the person it is for has no reason to suspect the
   * product does anything else. This is an ordinary verb that is true from the
   * first session and stays true, so it is drawn quietly — an accent on it
   * would be an advertisement on every screen of every session.
   *
   * It goes last in its own group, under the workspaces it makes more of.
   */
  create: boolean;
}

/**
 * Is this row the signed-in person's own brain?
 *
 * Both halves are required and neither is sufficient. `kind === "personal"`
 * alone is any brain, including one somebody shared with you; `role ===
 * "owner"` alone includes every workspace you created. Exactly one context can
 * satisfy both, because `createWorkspace` writes one personal context per
 * person and there is no transfer path — which is the property that lets this
 * be a mark on a row rather than a section of its own.
 */
export function isOwnBrain(context: ConsoleContext): boolean {
  return context.kind === "personal" && context.role === "owner";
}

/**
 * The person's own brain, or `null`.
 *
 * Exported because the rail is not the only surface that wants it, and because
 * "there is at most one" is a claim worth stating in one place rather than
 * re-deriving with a `.filter()[0]` at each call site.
 */
export function ownBrain(
  contexts: readonly ConsoleContext[],
): ConsoleContext | null {
  return contexts.find(isOwnBrain) ?? null;
}

export function railSections({
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
}): RailSection[] {
  // Your own brain first, and everything else in the order it arrived.
  // `filter` is stable, so this is a pin rather than a sort: the control plane
  // decides the rest of the order and this does not second-guess it.
  const brains = contexts.filter((context) => context.kind === "personal");
  const ordered = [
    ...brains.filter(isOwnBrain),
    ...brains.filter((context) => !isOwnBrain(context)),
  ];
  const workspaces = contexts.filter((context) => context.kind !== "personal");

  const sections: RailSection[] = [];
  // The empty console — no contexts and nothing to offer — still needs one
  // group to hold "Nothing here yet", and Brains is where a person with
  // nothing is going to end up first.
  const brainsHasSomethingToSay =
    ordered.length > 0 || claimable || (contexts.length === 0 && !creatable);
  if (brainsHasSomethingToSay) {
    sections.push({
      key: "brains",
      heading: "Brains",
      contexts: ordered,
      claim: claimable,
      create: false,
    });
  }
  if (workspaces.length > 0 || creatable) {
    sections.push({
      key: "workspaces",
      heading: "Workspaces",
      contexts: workspaces,
      claim: false,
      create: creatable,
    });
  }
  return sections;
}
