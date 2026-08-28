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
}

export function railSections({
  contexts,
  claimable,
}: {
  contexts: readonly ConsoleContext[];
  /** Whether the "Claim your @name" entry is being offered. */
  claimable: boolean;
}): RailSection[] {
  const own = contexts.filter((context) => context.role === "owner");
  const shared = contexts.filter((context) => context.role !== "owner");

  const sections: RailSection[] = [];
  if (own.length > 0 || claimable || contexts.length === 0) {
    sections.push({ key: "own", heading: "Yours", contexts: own, claim: claimable });
  }
  if (shared.length > 0) {
    sections.push({ key: "shared", heading: "Shared with you", contexts: shared, claim: false });
  }
  return sections;
}
