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
 * ## It is not per-note, and a note may still ask
 *
 * Opening another note while reading stays in reading mode, which is what a
 * reader wants and what a mode is. The alternative — resetting on every
 * selection — makes it a property of the note rather than of how you are
 * working, and then it belongs in the file rather than here.
 *
 * It now does belong in the file, for the notes that want it: a note may
 * declare `view: read` in its frontmatter, and `viewMode.ts` is that reader.
 * So there are **two** answers here rather than one, and they are kept apart
 * rather than collapsed into a single flag:
 *
 *  - `chosen` is the person's, set by the eye and the pencil. It is the mode,
 *    and it persists across notes exactly as it always did.
 *  - `declared` is the open note's, set when that note opens and cleared when
 *    the next one opens without a declaration.
 *
 * `declared ?? chosen` is what anybody sees. Collapsing them — having a
 * declaration simply call `setReadMode` — was the first version and is wrong in
 * the direction nobody would report as a bug: one form page would quietly put
 * the *session* into reading mode, and every ordinary note opened afterwards
 * would come up unwritable with nothing on screen saying why. A file may decide
 * how it is opened; it may not decide how you work.
 */

/** What the person last asked for, by pressing the eye or the pencil. */
let chosen = false;
/** What the open note's frontmatter asks for, or `null` when it asks nothing. */
let declared: boolean | null = null;
/** The answer those two add up to, which is the value subscribers hold. */
let reading = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Work out what the two answers come to, and tell everybody if it moved.
 *
 * Silent when the value is unchanged, so a caller that re-announces the state
 * it is already in does not re-render every subscriber — `useSyncExternalStore`
 * calls the snapshot on every notification, and this is on the path of a button
 * somebody may hold.
 */
function publish(): void {
  const next = declared ?? chosen;
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

/**
 * Turn it on or off, because somebody pressed the eye or the pencil.
 *
 * **This drops the open note's declaration**, which is what makes a default a
 * default: a form page that asked to be read is being edited from here on, and
 * the person's own answer is the one that persists onto the next note.
 */
export function setReadMode(next: boolean): void {
  chosen = next;
  declared = null;
  publish();
}

/**
 * What the note now opening asks for — `true` to read, `false` to edit, `null`
 * when it asks for nothing and the person's own mode should stand.
 *
 * Called by `viewMode.ts` and nowhere else; everything about *when* it is
 * called is documented there.
 */
export function declareReadMode(next: boolean | null): void {
  declared = next;
  publish();
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

/** Reset both layers, for a test that must not leak a mode into the next one. */
export function resetReadMode(): void {
  chosen = false;
  declared = null;
  publish();
}
