import { useSyncExternalStore } from "react";

/**
 * Reading mode: the note as it reads, rather than as it is written.
 *
 * ## Why a bus rather than a route parameter
 *
 * The toggle is in the frame's trailing group (`app/(app)/console/_layout.tsx`,
 * beside Share) and the editor it changes is inside `<Slot/>`, two components
 * away with no props between them. The obvious answer is the route — `?note=`
 * solves the same problem — and it was written that way first. It cost too
 * much: `BrowsePane` would import this module, this module would import
 * `expo-router`, and every test that mounts the pane would pull the real router
 * into its graph. Measured: **13 suites and 66 checks** stopped at
 * `SyntaxError: Unexpected token '<'` inside `expo-router`'s own TSX, none of
 * them about reading mode.
 *
 * So this is `bucketWrites.ts`'s shape, and its header has the argument
 * already: the writer and the reader may not import each other, both import a
 * module that knows about neither, and it is deliberately the smallest thing
 * that works — synchronous, one value, no replay.
 *
 * ## What that costs, stated rather than discovered
 *
 * The mode is **not in the URL**. A reload opens the note for editing again,
 * and a link somebody sends does not carry how they were looking at it. Both
 * are real and neither is load-bearing: this is a way to look at a note you
 * already have open, not a place. Putting it back in the route is a small
 * change *in the layout alone* — read `?read=1` there and call `setReadMode`
 * with it — and the pane never has to hear about routing for that to work.
 *
 * ## It is not per-note
 *
 * Opening another note while reading stays in reading mode, which is what a
 * reader wants and what a mode is. The alternative — resetting on every
 * selection — makes it a property of the note rather than of how you are
 * working, and then it belongs in the file rather than here.
 */

let reading = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Turn it on or off.
 *
 * A no-op when the value is unchanged, so a caller that re-announces the state
 * it is already in does not re-render every subscriber — `useSyncExternalStore`
 * calls the snapshot on every notification, and this is on the path of a button
 * somebody may hold.
 */
export function setReadMode(next: boolean): void {
  if (reading === next) return;
  reading = next;
  for (const listener of [...listeners]) {
    // A throwing subscriber must not stop the rest being told, the way
    // `announceBucketWrite` refuses to let one listener take the writer down.
    try {
      listener();
    } catch {
      // See above.
    }
  }
}

/** Is the open note being read rather than edited? */
export function useReadMode(): boolean {
  /*
   * The same function for both snapshots. There is no server here — this is a
   * client-only console — and passing `getSnapshot` twice is how React is told
   * that, rather than leaving the server argument off and having it warn about
   * a hydration mismatch it cannot have.
   */
  return useSyncExternalStore(subscribe, () => reading, () => reading);
}

/** Reset, for a test that must not leak a mode into the next one. */
export function resetReadMode(): void {
  setReadMode(false);
}
