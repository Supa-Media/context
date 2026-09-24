/**
 * How long `useFileBrowser` waits. Moved out of `useFileBrowser.ts` verbatim;
 * that file still exports both.
 */

/**
 * How long to wait for one file operation before giving the toolbar back.
 *
 * Longer than `SAVE_TIMEOUT_MS` (30s), and for the same reason
 * `CONNECT_TIMEOUT_MS` is: a save is one conditional PUT, while the operations
 * behind `run` are whole-tree jobs. A folder move, copy, delete or visibility
 * cascade walks the prefix and issues a bucket round trip per object, each with
 * its own 10s deadline in `functions/files.ts`, so a directory of any size is
 * legitimately many seconds of sequential I/O. 45s is generous enough that a
 * real folder operation over a slow provider is not cut off, and short enough
 * that nobody sits in front of a dead toolbar wondering.
 */
export const OPERATION_TIMEOUT_MS = 45_000;

/**
 * How long an online open waits for the bucket before showing the mirror's
 * copy. See `openNote`: long enough that an ordinary connection answers first
 * and nothing flickers, short enough that a slow one does not leave somebody
 * looking at a spinner over a note that is already on their device.
 */
export const INSTANT_OPEN_MS = 250;
