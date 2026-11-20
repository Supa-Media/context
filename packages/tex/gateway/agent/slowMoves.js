/**
 * A MOVE THAT RAN LONG IS STILL A MOVE (2026-10-24).
 *
 * In one person's texts, Tex archived a routine and was told at 20 s "That
 * call took too long and was stopped. Don't retry it", while the archive went
 * on and landed; a second try then answered "not found", and the person was
 * left watching Tex hunt for a note it had already moved. A dry run of ten
 * moves in a shared workspace was cut off the same way, so Tex gave up on
 * moving anything and told them the notes "haven't actually moved yet".
 *
 * A move in a keyed workspace is a control-plane row change followed by the
 * notes' editing history and every link to them (`moves/queuedFolder.js`), so
 * it can honestly need more than a read does. These limits give it that, cut
 * like every other to the turn's own end (`turn.js`), and a move that still
 * runs past one is told as what it is: maybe done, to be looked at before it
 * is tried again or reported as failed.
 */

/** Each rearranging tool's own limit, in ms. */
export const MOVE_TIMEOUTS = Object.freeze({
  move_note: 45_000,
  move_notes: 60_000,
  move_folder: 60_000,
  archive_note: 45_000,
});

/** What the model reads when a move ran past its limit. */
export const MOVE_TIMED_OUT =
  "That move is taking longer than usual and may still finish on its own. Don't say it failed and don't run it again blind: " +
  "list the folder it was going to (or read the note at its new path) to see where it is now, then carry on from there.";

/** Whether `name` is one of the rearranging tools. */
export function isMove(name) {
  return Object.hasOwn(MOVE_TIMEOUTS, name);
}
