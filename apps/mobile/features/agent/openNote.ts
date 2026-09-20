import { useSyncExternalStore } from "react";
import type { NoteReference } from "./page";

/**
 * The note on screen, published by the editor and read by anything beside it.
 *
 * ## Why this is a store and not a context
 *
 * Two surfaces need the same answer and neither is an ancestor of the other.
 * `NoteEditor` is the only thing that can build a `NoteReference` — it is the
 * one place that knows the etag it last saw and whether the draft has diverged
 * from it (`page.ts` says so where `noteReference` is defined, and refuses a
 * version taking loose fields for exactly that reason). The console's right
 * panel sits in the *frame*, beside the pane the editor is inside, so a
 * provider would have to be hoisted above both and threaded down through a
 * layout that has no other use for it.
 *
 * The alternative that looks cheaper is to rebuild the reference in the layout
 * from `selectedEntry`, which is right there. It is not cheaper, it is wrong:
 * a tree row carries a path and a visibility and knows nothing about the etag,
 * the encryption or the draft — so three of the five fields would be *claims*,
 * and the one this exists for would be the worst of them. `unsaved: false` on
 * a note somebody has been typing into tells the model the saved text is
 * current when it is not, which is the opposite of the honesty that field was
 * added for.
 *
 * So: one publisher, the one that knows, and a store the way `meetings` is a
 * store. `features/meetings/controller.ts` argues the same shape for a
 * different reason — a recording outlives the screen that started it — and
 * this one is here because a reader is a sibling of the writer.
 *
 * ## What it holds, and what it must never hold
 *
 * A `NoteReference`, which is the shape `page.ts` spends a section on: a path,
 * an etag, a visibility and two booleans. **No text, at any depth.** The whole
 * argument for that lives in `page.ts` and this module inherits it rather than
 * restating it — and `agentPage.test.ts`'s sentinel search covers whatever
 * comes out of here, because it is the same object.
 */

let current: NoteReference | null = null;
const listeners = new Set<() => void>();

/**
 * Publish what is open, or `null` for a folder, no note, or an unmounting
 * editor.
 *
 * **Compared before it is stored**, and the comparison is field by field
 * rather than by identity. `NoteEditor` rebuilds this object on every render —
 * every keystroke — and a store that notified on identity would re-render the
 * whole right panel, and the conversation inside it, on each one.
 */
export function publishOpenNote(next: NoteReference | null): void {
  if (same(current, next)) return;
  current = next;
  for (const listener of listeners) listener();
}

function same(a: NoteReference | null, b: NoteReference | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.path === b.path &&
    a.etag === b.etag &&
    a.visibility === b.visibility &&
    a.readable === b.readable &&
    a.unsaved === b.unsaved
  );
}

/**
 * Tell me when it changes.
 *
 * Exported because React is not the only reasonable subscriber and because a
 * store whose subscription is private forces its tests to fake a renderer to
 * ask a question with no React in it. `useOpenNote` is this plus
 * `useSyncExternalStore`.
 */
export function subscribeToOpenNote(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The stored reference, and the same object each time until it changes.
 *
 * `useSyncExternalStore` calls the getter during render and compares by
 * identity, so returning a fresh object would loop. `publishOpenNote`'s
 * field-by-field guard is what makes the identity stable, which is why the two
 * belong in one file.
 *
 * Exported rather than closed over, and not only for the tests: a reader that
 * is not a hook is the honest shape for a store, and the alternative — reaching
 * the getter through the hook — is a test that has to fake a renderer to ask a
 * question with no React in it.
 */
export function openNoteSnapshot(): NoteReference | null {
  return current;
}

export function useOpenNote(): NoteReference | null {
  return useSyncExternalStore(subscribeToOpenNote, openNoteSnapshot, openNoteSnapshot);
}

/** For tests, and for nothing else: put the store back to its resting state. */
export function resetOpenNote(): void {
  current = null;
  for (const listener of listeners) listener();
}
