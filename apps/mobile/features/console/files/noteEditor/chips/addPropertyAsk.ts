/**
 * "Add property" from the phone's ••• sheet, carried to the open note.
 *
 * A loose note — one outside the Projects folder — draws no faint chips over
 * its name on a phone (owner, 2026-10-18, board A of `loose-note-chips`), so
 * the way to give it a property is ••• → Add property. That sheet is drawn by
 * the console frame (`layout/NoteActionsSheet.tsx`) and the Properties card it
 * opens is inside the note editor, with no props between them: `readMode.ts`'s
 * shape, the smallest thing that works. Synchronous, no replay: an ask with no
 * note open to hear it is dropped.
 */

const listeners = new Set<() => void>();

/** Open the open note's Properties card on its Add row. */
export function askAddProperty(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One listener must not stop the rest being told.
    }
  }
}

/** Hear the ask; returns the way to stop. */
export function onAddPropertyAsked(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
