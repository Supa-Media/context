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
 * ## And a fourth thing, which is not a state but a date
 *
 * **Every count here is a measurement taken at a past instant.** `noteCount` is
 * written by exactly one thing — the walk `verifyStorageBinding` runs — and
 * nothing that writes notes updates it: not the gateway, not `write_note`, not
 * email ingestion, not this console's own editor. A context verified while
 * empty and then filled in by a connected AI client contributes `0` to this sum
 * for ever.
 *
 * That is **not** a floor, which is why the `+` is the wrong answer to it:
 * notes are deleted as well as written, so a stale count can be over as easily
 * as under. The honest answer is the one Settings → Storage already gives for
 * the same number — say when it was taken — and the total is dated by its
 * *oldest* contributing walk, because a sum is only as fresh as its stalest
 * part. One undated contributor undates the total: a date the sum cannot
 * support is worse than none.
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

import { relativeTime } from "./format";

/** The fields of a storage binding this cares about. */
export interface CountedBinding {
  noteCount?: number;
  noteCountTruncated?: boolean;
  /** When the walk that produced `noteCount` ran. */
  noteCountedAt?: number;
}

export interface NotesTotal {
  notes: number;
  /** The real number is this or higher. Render with a `+`. */
  partial: boolean;
  /**
   * The oldest contributing walk, or `undefined` when any contributor was
   * undated. See the header: this is what stops the tile claiming to be now.
   */
  countedAt?: number;
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
  /** The oldest contributing walk, once every contributor has carried one. */
  let countedAt: number | undefined = undefined;
  let undated = false;

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

    // Oldest wins, and an undated contributor wins over every date: the sum
    // cannot be dated more confidently than its least-dated part.
    if (binding.noteCountedAt === undefined) undated = true;
    else if (countedAt === undefined || binding.noteCountedAt < countedAt) {
      countedAt = binding.noteCountedAt;
    }
  }

  if (counted === 0) return null;
  return {
    notes,
    partial: truncated || missing > 0,
    ...(undated || countedAt === undefined ? {} : { countedAt }),
  };
}

/** "1,284" — or "1,284+" when the total is a floor. */
export function formatNotesTotal(total: NotesTotal): string {
  return `${total.notes.toLocaleString("en-US")}${total.partial ? "+" : ""}`;
}

/**
 * The tile's caption, which is where the date goes.
 *
 * The value is a number and has no room for a clause; the label under it does.
 * Without one the tile asserts a live figure it cannot support — see the
 * header — and with one it says exactly what Settings → Storage says about the
 * same walk. An undated total keeps the caption it has always had rather than
 * guessing at a freshness nothing measured.
 */
export function notesTotalLabel(total: NotesTotal, now: number): string {
  if (total.countedAt === undefined) return "notes across all";
  return `notes counted ${relativeTime(total.countedAt, now)}`;
}
