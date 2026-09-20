/**
 * What a move into another context says while it is happening, and after.
 *
 * A pure module for the reason every rule in this folder is one: the console's
 * tests run in plain node with no renderer, and a sentence composed inside a
 * component is a sentence nobody can check. It matters more than usual here,
 * because this is the only file operation whose *outcome* a person learns about
 * from a line of text rather than from the tree changing in front of them — the
 * move outlives the press, and by the time the last batch lands the toast that
 * started it is long gone.
 *
 * Three states, three different things to say, and the distinction that keeps
 * being worth the extra branch:
 *
 *  - **`moving` is a report, not a request.** Nothing is expected of the
 *    person, and the one thing they need to know is that closing the console
 *    does not stop it.
 *  - **`complete` with something left behind is not a success.** "Moved" over a
 *    folder that still has three encrypted notes in it sends somebody to the
 *    other context looking for notes that are not there. The count is named,
 *    and so is the reason.
 *  - **`failed` is the only one with a button.** Everything already carried is
 *    carried, so the offer is "finish it", not "start again" — and saying that
 *    is what stops somebody re-running a move they think did nothing.
 */

import type { ContextMoveProgress } from "./browser";

export interface ContextMoveNotice {
  id: string;
  /**
   * `warn` is for something the person has to act on, matching the band's own
   * rule in `BrowsePane` — a failure, or a move that finished incomplete.
   * `hint` is a report.
   */
  tone: "hint" | "warn";
  text: string;
  /** Whether to offer picking it back up. Only ever on a failure. */
  resumable: boolean;
  /**
   * Whether a Dismiss button would do anything.
   *
   * False while the move is still running, and the reason is that a control
   * that does nothing is worse than no control: `contextMoveNotices` keeps a
   * running move on screen whatever the dismissed set says, so a Dismiss drawn
   * beside one would be pressed and ignored.
   */
  dismissible: boolean;
}

/** `312 notes` / `1 note`, because "1 notes" is the tell that nobody read it. */
function countOf(objects: number): string {
  return objects === 1 ? "1 note" : `${objects} notes`;
}

export function describeContextMove(move: ContextMoveProgress): ContextMoveNotice {
  const what = `${move.from} → ${move.destination}/${move.to}`;
  if (move.status === "moving") {
    return {
      id: move.id,
      tone: "hint",
      text:
        move.objects === 0
          ? `Moving ${what}. This keeps going if you close the console.`
          : `Moving ${what} — ${countOf(move.objects)} so far. This keeps going if you close the console.`,
      resumable: false,
      dismissible: false,
    };
  }
  if (move.status === "failed") {
    return {
      id: move.id,
      tone: "warn",
      // The count first, because "nothing happened" is the wrong thing to
      // conclude and the most natural one: a move that stopped at batch forty
      // really did move the first thirty-nine batches.
      text:
        `${countOf(move.objects)} moved to ${move.destination} before this stopped. ` +
        (move.error ?? "The move could not be completed.").trim(),
      resumable: true,
      dismissible: true,
    };
  }
  if (move.skipped.length > 0) {
    return {
      id: move.id,
      tone: "warn",
      text:
        `Moved ${countOf(move.objects)} to ${move.destination}. ` +
        `${move.skipped.length === 1 ? "One note" : `${move.skipped.length} notes`} stayed here ` +
        "because they are encrypted to this context and could not be read anywhere else: " +
        `${move.skipped.map((entry) => entry.path).join(", ")}.`,
      resumable: false,
      dismissible: true,
    };
  }
  return {
    id: move.id,
    tone: "hint",
    text: `Moved ${countOf(move.objects)} to ${move.destination}.`,
    resumable: false,
    dismissible: true,
  };
}

/**
 * The lines worth drawing, newest first, minus anything already dismissed.
 *
 * Dismissal is the caller's state rather than the row's, and deliberately: a
 * finished move stays on the server for a day so it does not vanish from
 * somebody else's screen at ninety-nine percent, and a person who has read it
 * here should not have to read it again on every paint. A move still running
 * is **not** dismissible for the same reason it is not a request — there is
 * nothing to acknowledge, and hiding it would hide the only thing on screen
 * that says work is outstanding.
 */
export function contextMoveNotices(
  moves: readonly ContextMoveProgress[],
  dismissed: ReadonlySet<string>,
): ContextMoveNotice[] {
  return moves
    .filter((move) => move.status === "moving" || !dismissed.has(move.id))
    .map(describeContextMove);
}
