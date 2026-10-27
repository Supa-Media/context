/**
 * Which shared notes have a controller driving their record on this device.
 *
 * A note's durable record (its Yjs snapshot, unsent updates, offline draft)
 * has one writer at a time. The editor's controller is that writer while the
 * note is open; `closedNotes.ts` sends what a closed note left behind, and
 * only for a note nobody has open. Opening a note the background is sending
 * stops that send and waits for its last save to land before the editor's
 * controller reads the record, so the two never write over each other. A send
 * cut off mid-request is safe to repeat: the gateway keeps a replacement by
 * its base and text, and a Yjs update applied twice is applied once.
 */

const open = new Map<string, number>();
const background = new Map<string, () => Promise<void>>();

/** The editor holds this note now; resolves once any background send of it has stood down. */
export function openNote(key: string): Promise<void> {
  open.set(key, (open.get(key) ?? 0) + 1);
  const sending = background.get(key);
  if (sending === undefined) return Promise.resolve();
  background.delete(key);
  return sending();
}

export function closeNote(key: string): void {
  const count = open.get(key) ?? 0;
  if (count <= 1) open.delete(key);
  else open.set(key, count - 1);
}

/**
 * Take a closed note for a background send. `null` when it is open or already
 * being sent; otherwise a release, and `standDown` is called if the note is
 * opened meanwhile.
 */
export function sendInBackground(key: string, standDown: () => Promise<void>): (() => void) | null {
  if (open.has(key) || background.has(key)) return null;
  background.set(key, standDown);
  return () => {
    if (background.get(key) === standDown) background.delete(key);
  };
}
