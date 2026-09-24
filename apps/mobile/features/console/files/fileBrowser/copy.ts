/**
 * What `useFileBrowser` says: the sentences its operations answer with, and the
 * small helpers that build them. Moved out of `useFileBrowser.ts` verbatim.
 */
import { displayPath } from "../paths";
import { namesIn } from "../tree";
import type { Listings } from "./types";

/**
 * Where the draft for a note nobody is looking at actually is.
 *
 * Said out loud because the alternative is a notice about a save that did not
 * land and no answer to "so where is what I typed". It is on the device — and
 * how much that is worth depends on whether the store is durable, exactly as
 * the queued-save message does: a browser refusing `localStorage` gives a copy
 * that lives as long as the tab, and telling somebody it is kept there would
 * be a durability claim the console cannot make.
 */
export function draftIsKept(durable: boolean): string {
  return durable
    ? "Its draft is kept on this device — open the note to try again."
    : "Its draft is held for this session — open the note to try again. Closing the app loses it.";
}

/**
 * What to say when we stopped waiting.
 *
 * It does not claim the operation failed, because we do not know: the request
 * may have landed and only the answer was lost. Saying "try again" here is how
 * somebody retries a rename that already succeeded and gets told the name is
 * taken — so the sentence points at the list instead.
 */
export const TIMED_OUT_MESSAGE =
  "That is taking too long, so we stopped waiting. It may still have gone through — check the list before trying it again.";

/**
 * The mutation worked; reloading the listing afterwards did not.
 *
 * Reported separately from a failure because they are opposite facts. Folding
 * the two together is what told somebody a successful rename "did not work",
 * and the retry they were invited to make then failed on the duplicate name.
 */
/**
 * An operation that cannot wait for a connection, asked for without one — a
 * duplicate, a paste, a visibility change. Said at once, because saying it
 * after the operation timeout would be "we do not know" about a request that
 * was never made.
 */
export const NEEDS_CONNECTION =
  "You are offline, so that was not done. It needs a connection — new notes, renames, moves, archiving and deleting are the things that can wait for one.";

/** A name the offline queue is holding for something else. See `claimedPaths`. */
export function claimedMessage(name: string): string {
  return `${name} has a change waiting to sync. Choose another name, or use this one once it has synced.`;
}

/** A folder operation asked for offline. See the offline section of `rename`. */
export const FOLDER_NEEDS_CONNECTION =
  "Renaming, moving, archiving or deleting a folder needs a connection. A folder's notes can change on other devices while this one is offline, and there is no single version of a folder to check that against.";

/** A note whose version this device does not hold. */
export const NOT_ON_DEVICE =
  "This note is not on this device, so it cannot be changed offline. Open it once with a connection and try again.";

/**
 * Drawings are online-only to create. The drawing editor on a phone is never
 * kept offline (`drawingOffline.ts`), and on the web it is kept only once a
 * drawing has been opened online — so a drawing made offline could open as a
 * picture nobody can draw in. A note can be made now.
 */
export const DRAWING_NEEDS_CONNECTION =
  "A new drawing needs a connection, because its editor may not be on this device yet. A note can be made offline.";

export const STALE_LISTING_MESSAGE =
  "That worked, but the file list did not reload. What you see may be out of date.";

/**
 * A folder, as it should read in the middle of a sentence.
 *
 * The root is `""`, and "Moved to ." is not a sentence. Every other place that
 * has to name the root spells it out too — the move picker's `detail`, the new
 * note dialog's description — so this says the same thing they do about *that*.
 *
 * It says something different about the folders below it, and deliberately:
 * `displayPath` drops their sort numbers, because this is a sentence somebody
 * reads about a move that has already happened, and it should name the folder
 * the way the tree, the crumb and the folder's own heading just named it. The
 * picker keeps the real keys, which is the opposite decision for the opposite
 * reason — there the string is a destination being chosen, not a place being
 * reported.
 */
/*
  Its own function rather than `paths.ts`'s `folderLabel`, and the name is
  shared deliberately: that one labels a folder's *name*, this one names a
  *place* in a sentence and has the root's wording to give. Both are contained
  — this one through `displayPath` — so the three toasts below that used to
  trim a name by hand now go through a container either way.
*/
export function folderLabel(folder: string): string {
  return folder === "" ? "the root of your context" : displayPath(folder);
}

/** "1 item", "3 items". */
export function countOf(count: number): string {
  return count === 1 ? "1 item" : `${count} items`;
}

/** "That folder already has a …" — checked here so it costs no round trip. */
export function collision(listings: Listings, folder: string, name: string): string | null {
  return namesIn(listings, folder).has(name)
    ? `${folder === "" ? "The root" : folder} already has something called ${name}.`
    : null;
}
