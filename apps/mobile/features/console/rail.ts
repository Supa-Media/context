/**
 * How the rail groups the contexts a person can reach.
 *
 * One flat list under "Contexts" made a context you own and a context you were
 * invited into indistinguishable — and the difference is the one fact the rail
 * exists to answer at a glance: *whose* notes am I about to open? So the list
 * splits on ownership, not on kind: everything where your role is `owner`
 * (your personal context, and any shared workspace you created) stays under
 * **Contexts**, and everything else — any context that is yours to visit
 * rather than yours — moves under **Shared with you**.
 *
 * A section with nothing in it is omitted, header and all: an account that has
 * never been invited anywhere should not scroll past an empty "Shared with
 * you", and a heading over nothing reads as something failing to load. The one
 * asymmetry is deliberate: the **own** section also exists while it has no
 * contexts to show, whenever it still has something to say — the
 * "Claim your @name" entry (which, per the durable decision in `CLAUDE.md`,
 * lives last in the Contexts group precisely because that group raises the
 * question it answers), and the "Nothing here yet" empty state of an account
 * with nothing at all.
 */

import type { ConsoleContext } from "./types";

export interface RailSection {
  key: "own" | "shared";
  heading: string;
  contexts: ConsoleContext[];
  /** The own section carries the claim entry when the person owns nothing. */
  claim: boolean;
  /**
   * The own section carries the "New workspace" entry.
   *
   * Separate from `claim` rather than folded into it because the two answer
   * different questions and are true at different times. `claim` is "you have
   * no context of your own", which stops being true forever the moment it is
   * used. This is "you can make a shared one", which is true from the first
   * moment and stays true — it is an ordinary verb, not a gap in the list, and
   * it is drawn as one.
   *
   * Both live in the **own** group and this one goes last, under the claim
   * entry when both are showing. A workspace you create appears in that group
   * (you own it), so the entry belongs where its result will appear; and
   * putting a permanent verb above the one-time prompt would bury the prompt
   * that has to be noticed.
   */
  create: boolean;
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
  const own = contexts.filter((context) => context.role === "owner");
  const shared = contexts.filter((context) => context.role !== "owner");

  const sections: RailSection[] = [];
  if (own.length > 0 || claimable || creatable || contexts.length === 0) {
    sections.push({
      key: "own",
      heading: "Yours",
      contexts: own,
      claim: claimable,
      create: creatable,
    });
  }
  if (shared.length > 0) {
    sections.push({
      key: "shared",
      heading: "Shared with you",
      contexts: shared,
      claim: false,
      create: false,
    });
  }
  return sections;
}
