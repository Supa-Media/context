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
 * Takes one entry per reachable context — `null` for a context with no storage
 * binding — so the difference between "no bucket" and "a bucket nobody has
 * walked" survives into the answer.
 */
export function totalNotes(
  bindings: ReadonlyArray<CountedBinding | null | undefined>,
): NotesTotal | null {
  let notes = 0;
  let counted = 0;
  let bound = 0;
  let truncated = false;

  for (const binding of bindings) {
    if (binding === null || binding === undefined) continue;
    bound += 1;
    if (binding.noteCount === undefined) continue;
    counted += 1;
    notes += binding.noteCount;
    if (binding.noteCountTruncated === true) truncated = true;
  }

  if (counted === 0) return null;
  return { notes, partial: truncated || counted < bound };
}

/** "1,284" — or "1,284+" when the total is a floor. */
export function formatNotesTotal(total: NotesTotal): string {
  return `${total.notes.toLocaleString("en-US")}${total.partial ? "+" : ""}`;
}
