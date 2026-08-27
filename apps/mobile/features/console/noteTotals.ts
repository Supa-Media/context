/**
 * How many notes there are across every context you can reach.
 *
 * The console has never shown this. That was not an oversight — issues #20 and
 * #25 were the same bug on two surfaces: "notes across all" and a bucket's
 * object count were constants from `placeholderData.ts` drawn as verified facts
 * about somebody's own storage. The fix at the time was to delete the tiles,
 * because nothing counted a bucket and there was no honest number to put in
 * them. Something counts one now (`functions/lib/noteCount.ts`), so this is the
 * arithmetic that turns per-binding counts into the tile.
 *
 * ## Three states, and the third is the one that gets lied about
 *
 * A total is **exact**, **a floor**, or **absent**, and collapsing the middle
 * one into the first is how #25 would come back. A count is a floor when any
 * bucket's walk hit its page budget, and also when a context that *has* a
 * bucket has never been walked — its notes are real and are missing from the
 * sum. Either way the tile must say "1,284+" rather than "1,284".
 *
 * A context with **no binding at all** is a genuine zero rather than an
 * unknown: there is no bucket, so there are no notes, and counting it as
 * missing would mark every total on a half-connected account as a floor
 * forever.
 *
 * ## `null` and `undefined` mean different things here, and must
 *
 * `null` is "this context has no bucket" — a fact, worth zero. `undefined` is
 * "we do not know what this context has": the query has not landed, or it
 * errored. Collapsing them was a real bug on every first paint — a context
 * still loading counted as bucketless, so the tile printed an *exact* total
 * that was missing a whole bucket's notes, and then corrected itself a moment
 * later. An unknown makes the total a floor, which is what a floor is for.
 */

/** The fields of a storage binding this cares about. */
export interface CountedBinding {
  noteCount?: number;
  noteCountTruncated?: boolean;
}

export interface NotesTotal {
  notes: number;
  /** The real number is this or higher. Render with a `+`. */
  partial: boolean;
}

/**
 * Sum what has been counted, or `null` when nothing has been.
 *
 * `null` rather than zero, and the caller renders no tile at all rather than an
 * em dash: #20 shipped a permanent em dash to accounts with no contexts and
 * kept inventing numbers for everyone else. A tile that can only ever say "we
 * do not know" is worse than one that is not there.
 *
 * Takes one entry per reachable context: the binding, `null` for a context with
 * no storage binding, or `undefined` for one whose binding we cannot see yet.
 * All three are distinct — see the header.
 */
export function totalNotes(
  bindings: ReadonlyArray<CountedBinding | null | undefined>,
): NotesTotal | null {
  let notes = 0;
  let counted = 0;
  /** Contexts whose notes are real and are not in `notes`. */
  let missing = 0;
  let truncated = false;

  for (const binding of bindings) {
    // No bucket, so no notes. A real zero, and it must not make the sum a
    // floor — otherwise anybody who skipped storage on one context wears a
    // `+` forever.
    if (binding === null) continue;

    // Unknown: still loading, or the query errored. Not zero.
    if (binding === undefined) {
      missing += 1;
      continue;
    }

    if (binding.noteCount === undefined) {
      // A bucket nobody has walked — or somebody else's, whose census the
      // control plane withholds from anyone but its owner.
      missing += 1;
      continue;
    }

    counted += 1;
    notes += binding.noteCount;
    if (binding.noteCountTruncated === true) truncated = true;
  }

  if (counted === 0) return null;
  return { notes, partial: truncated || missing > 0 };
}

/** "1,284" — or "1,284+" when the total is a floor. */
export function formatNotesTotal(total: NotesTotal): string {
  return `${total.notes.toLocaleString("en-US")}${total.partial ? "+" : ""}`;
}
