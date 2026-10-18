/**
 * A NEW NOTE OPENS ON THE PRESS, AND IS NOT SAVED UNTIL SOMEBODY WRITES IN IT.
 *
 * Dev2 (2026-10-18): *"the compose button takes more than 5 seconds to open a
 * new note"* and *"make sure that new notes created on mobile but nothing
 * written in it doesn't get saved and is discarded"*.
 *
 * The press used to wait for the note's create in the bucket, and then for the
 * shared document of the note it had just made, before the editor took a
 * keystroke. Now an untitled note is opened at once from its seed text, with
 * no version (`etag: null`), and its row is drawn in its folder. Nothing is
 * written: the first save of what somebody types is the create — the same
 * `writeNote` with no expected version, which the server refuses over a note
 * that is already there. A note left with nothing but the heading it was made
 * with is never written, and leaving it takes its row back.
 *
 * This is the online half. Offline, the same note is a queued create
 * (`useNoteCreate`), and the same rule applies to it: the drain does not send
 * a blank one (`offline/sync.ts`), and leaving it drops it from the queue.
 */

/** A new note on screen that is in no bucket yet. */
export interface UnsentCreate {
  /** Take the row back: the note is being left with nothing written in it. */
  discard: () => void;
  /** The first save landed: the note is an ordinary note from now on. */
  landed: () => void;
  /**
   * The first save was refused because the name is taken — made on another
   * device since this one's listing was read. The next untitled name, with
   * its row drawn instead of this one's, or `null` once a handful in a row
   * were taken (that is not a stale listing, and the refusal is shown).
   */
  retarget: () => string | null;
  /**
   * What to say instead of the server's answer to a create refused as missing:
   * that is a folder this person may not add to, which the server rightly
   * answers exactly as an absent file.
   */
  refusal: () => Error;
}

export type UnsentCreates = Map<string, UnsentCreate>;

export { isBlankNewNote } from "../../../offline/blankNewNote";
