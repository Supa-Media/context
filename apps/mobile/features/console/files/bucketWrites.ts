/**
 * Something wrote to the bucket that was not the console.
 *
 * ## The defect this closes
 *
 * The console refreshes a folder when **it** writes into it — `save` calls
 * `refresh([parentPath(path)])`, and so do create, move, archive and the rest.
 * Every one of those is the console changing the bucket and telling itself.
 *
 * A meeting is the first write in this product that goes to the same bucket
 * from somewhere else. `writeNoteThrough` puts the note there directly, the
 * console hears nothing, and the folder it landed in keeps whatever listing it
 * already had — a listing that is now missing a file. Reported from a phone:
 * "after saving the meeting it did not show up on the mobile app, but it showed
 * up on the web app". The web app had never read that folder, so it had nothing
 * stale to show; the phone had.
 *
 * ## Why a bus rather than a call
 *
 * The writer is `features/meetings` and the reader is `useFileBrowser`, and
 * neither may import the other: the console must not know that meetings exist —
 * it is a file browser over a bucket, and the day a second outside writer
 * appears it must not need a second branch — and the meetings gateway must not
 * hold a console hook. Both import this module, which knows about neither.
 *
 * It is deliberately the smallest thing that works: synchronous, unbuffered,
 * no replay. A subscriber that is not mounted misses the event, which is
 * correct — a console that mounts *after* the write reads the folder fresh on
 * the way in and has nothing to invalidate.
 *
 * ## What it carries, and what it does not
 *
 * The workspace and the path, because the reader has to answer "is this my
 * bucket, and which folder" and can answer nothing else from a path. **Not the
 * text**: this is a signal that a listing is stale, not a second channel for
 * note bodies. A subscriber that took the content from here would be holding a
 * copy the cache never saw, at a clearance nobody checked.
 */
export interface BucketWrite {
  /** The workspace whose bucket was written to. */
  workspaceId: string;
  /** The key that was written, e.g. `0-inbox/meetings/2026-09-07-standup-a1b2.md`. */
  path: string;
}

type Listener = (write: BucketWrite) => void;

const listeners = new Set<Listener>();

/**
 * Say that a note landed at `path` in `workspaceId`.
 *
 * Called after the write has succeeded, never before: an announcement of a
 * write that then failed makes every listener reload a folder to learn nothing,
 * and — worse — makes the console's "the file list did not reload" notice fire
 * about an operation that never happened.
 *
 * A throwing listener must not take the writer down with it. The write is done
 * and the caller's own path is finished; a subscriber that fails is a stale
 * listing, which is the state this exists to improve and not one to fail into.
 */
export function announceBucketWrite(write: BucketWrite): void {
  for (const listener of [...listeners]) {
    try {
      listener(write);
    } catch {
      // See above.
    }
  }
}

/** Listen until the returned function is called. */
export function onBucketWrite(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
