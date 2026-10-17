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
 *    person, so it carries no control at all.
 *  - **`complete` with something left behind is not a success.** "Moved" over a
 *    folder that still has three encrypted notes in it sends somebody to the
 *    other context looking for notes that are not there. The count is named,
 *    and so is the reason.
 *  - **`failed` is the only one that offers to try again.** Everything already
 *    carried stays carried, so the count leads — that is what stops somebody
 *    thinking a move that stopped partway did nothing.
 *
 * Every line is short and names the item, not its path: it is drawn on one row
 * with its controls beside it, and a paragraph there was the complaint.
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

/**
 * The moved item by its own name, not its path.
 *
 * The full `from → @dest/to` pair read as a log line, and the person already
 * knows where they pressed: what they need is which thing, and where it went.
 */
function nameOf(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  // A note without `.md`, the way the tree names it.
  return (segments[segments.length - 1] ?? path).replace(/\.md$/i, "");
}

/** The server's reason as a second sentence, or nothing — never a stand-in. */
function reasonOf(error: string | undefined): string {
  const reason = (error ?? "").trim();
  if (reason.length === 0) return "";
  return ` ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`;
}

export function describeContextMove(move: ContextMoveProgress): ContextMoveNotice {
  const name = nameOf(move.from);
  if (move.status === "moving") {
    return {
      id: move.id,
      tone: "hint",
      text:
        move.objects === 0
          ? `Moving ${name} to ${move.destination}…`
          : `Moving ${name} to ${move.destination}, ${countOf(move.objects)} so far…`,
      resumable: false,
      dismissible: false,
    };
  }
  if (move.status === "failed") {
    return {
      id: move.id,
      tone: "warn",
      // A count when there is one, because a move that stopped at batch forty
      // really did carry the first thirty-nine, and "didn't move" over that
      // sends somebody looking in the wrong context.
      text:
        (move.objects === 0
          ? `${name} didn't move to ${move.destination}.`
          : `${name} stopped partway: ${countOf(move.objects)} ${move.objects === 1 ? "is" : "are"} in ${move.destination}.`) +
        reasonOf(move.error),
      resumable: true,
      dismissible: true,
    };
  }
  const lines = [`Moved ${name} to ${move.destination}.`];
  const encrypted = move.skipped.filter((entry) => entry.reason === "encrypted");
  const large = move.skipped.filter((entry) => entry.reason === "too_large");
  if (encrypted.length > 0) {
    lines.push(
      `${encrypted.length === 1 ? "1 encrypted note" : `${encrypted.length} encrypted notes`} stayed here: ` +
        `${encrypted.map((entry) => entry.path).join(", ")}.`,
    );
  }
  if (large.length > 0) {
    lines.push(
      `${large.length === 1 ? "1 file" : `${large.length} files`} too large to move stayed here; ` +
        `upload ${large.length === 1 ? "it" : "them"} there: ${large.map((entry) => entry.path).join(", ")}.`,
    );
  }
  return {
    id: move.id,
    tone: move.skipped.length > 0 ? "warn" : "hint",
    text: lines.join(" "),
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
