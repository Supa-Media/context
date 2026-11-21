/**
 * Where Tex's edit goes in the note. Tex returns the words it wants in place of
 * the highlighted ones; when those start with the highlighted words, Tex is
 * adding (an outline under a heading, a line after a list), so only the new
 * part is written, after the comment's close marker: the added words are the
 * note's own text, never part of the highlight the person tagged. Otherwise
 * the highlighted words are replaced, inside the highlight.
 */

import type { EditorState } from "@codemirror/state";
import { MARKER_RE } from "@context/shared/src/comments.cjs";

export interface TexAnchor {
  from: number;
  to: number;
  closeEnd: number;
}

export interface TexEdit {
  from: number;
  to: number;
  insert: string;
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
    return insert === "" ? null : { from: anchor.closeEnd, to: anchor.closeEnd, insert, adding: true };
  }
  return { from: anchor.from, to: anchor.to, insert: replace, adding: false };
}
