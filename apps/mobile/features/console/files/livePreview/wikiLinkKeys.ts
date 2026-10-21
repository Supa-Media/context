/**
 * Backspace and Delete beside a wiki link step into it rather than eat it.
 *
 * A link with no alias is drawn as its note's name, and a caret at either edge
 * no longer shows its source (`wikiLinkSpans` in `reveal.ts`). So the caret
 * that picking from the `[[` list leaves just after the link sits after a `]]`
 * nobody can see, and a plain Backspace deleted one of those brackets: the
 * link broke and its whole path appeared at once. The first press steps the
 * caret inside instead, to the end of the name, where the source is drawn and
 * the next press deletes the character the person is looking at. Delete
 * before a link is the mirror. An embed (`![[…]]`) is a picture and keeps
 * CodeMirror's own handling.
 */

import { EditorSelection, Prec, type EditorState } from "@codemirror/state";
import { keymap, type Command } from "@codemirror/view";

const BEFORE = /(?:^|[^!])\[\[[^[\]]+\]\]$/;
const AFTER = /^\[\[[^[\]]+\]\]/;

/** Where Backspace (`back`) or Delete moves an empty caret, or null to delete. */
export function wikiLinkStep(state: EditorState, back: boolean): number | null {
  const range = state.selection.main;
  if (state.selection.ranges.length !== 1 || !range.empty) return null;
  const pos = range.head;
  const line = state.doc.lineAt(pos);
  if (back) {
    return BEFORE.test(line.text.slice(0, pos - line.from)) ? pos - 2 : null;
  }
  const behind = pos > line.from ? state.doc.sliceString(pos - 1, pos) : "";
  return behind !== "!" && AFTER.test(line.text.slice(pos - line.from)) ? pos + 2 : null;
}

function step(back: boolean): Command {
  return (view) => {
    const to = wikiLinkStep(view.state, back);
    if (to === null) return false;
    view.dispatch({ selection: EditorSelection.cursor(to) });
    return true;
  };
}

export const wikiLinkKeys = Prec.high(
  keymap.of([
    { key: "Backspace", run: step(true) },
    { key: "Delete", run: step(false) },
  ]),
);
