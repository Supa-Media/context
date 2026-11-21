/**
 * Where Tex's edit goes in the note. Tex returns the words it wants in place of
 * the highlighted ones. What Tex writes is the note's own text and is never
 * highlighted as part of the comment (Dev2, 2026-11-21):
 * - When the new words start with the highlighted ones, Tex is adding (an
 *   outline under a heading, a line after a list): only the new part is
 *   written, after the comment's close marker.
 * - Otherwise the highlighted words are taken out and the new ones written
 *   after the close marker, so the thread is left as a point where the words
 *   were, still there to open, and the new words are plain text.
 */

import type { EditorState } from "@codemirror/state";
import { MARKER_RE } from "@context/shared/src/comments.cjs";

export interface TexAnchor {
  from: number;
  to: number;
  closeEnd: number;
}

export interface TexEdit {
  /** In the current document's positions, in order, not overlapping. */
  changes: { from: number; to: number; insert: string }[];
  /** True when the highlighted words stay and the new words follow them. */
  adding: boolean;
}

/** The highlighted words as a reader sees them, comment markers removed. */
export function anchorWords(state: EditorState, anchor: TexAnchor): string {
  return state.sliceDoc(anchor.from, anchor.to).replace(MARKER_RE, "");
}

/** Whether `text` (all or the start of Tex's words) adds after `words` rather than replacing them. */
export function isAddition(words: string, text: string): boolean {
  return words === "" || text.startsWith(words) || words.startsWith(text);
}

/** The change that writes `replace` into the note, or null when it changes nothing. */
export function texEditFor(state: EditorState, anchor: TexAnchor, replace: string): TexEdit | null {
  const words = anchorWords(state, anchor);
  if (replace === words) return null;
  if (words === "" || replace.startsWith(words)) {
    const insert = replace.slice(words.length);
    return insert === "" ? null : { changes: [{ from: anchor.closeEnd, to: anchor.closeEnd, insert }], adding: true };
  }
  // Another thread's markers inside the words stay where the words were, as Keep
  // always kept them (`keepSuggestion`): dropping one would leave its partner
  // showing as text and its thread with no words.
  const others = state.sliceDoc(anchor.from, anchor.to).match(MARKER_RE) ?? [];
  return {
    changes: [
      { from: anchor.from, to: anchor.to, insert: others.join("") },
      { from: anchor.closeEnd, to: anchor.closeEnd, insert: replace },
    ],
    adding: false,
  };
}
