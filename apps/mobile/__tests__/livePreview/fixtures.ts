/**
 * LIVE PREVIEW — the decoration logic, without a browser.
 *
 * The behaviour being pinned is the one that makes the editor feel like
 * Obsidian rather than like a styled textarea: **markup hides when your cursor
 * is elsewhere and comes back the instant you enter it.**
 *
 * These run against real `EditorState` and a real lezer Markdown tree — only
 * the DOM is absent. That matters: the interesting failures here are all
 * tree-shaped (which node contains which mark, where a reveal unit starts) and
 * a test against a hand-built fake tree would prove nothing about the grammar
 * this actually parses with.
 *
 * The bug this file exists to prevent is text jumping under the caret. If the
 * reveal unit is wrong — the mark instead of its container, or exclusive
 * boundaries instead of inclusive — the document reflows sideways as somebody
 * arrows through a bold word, and every one of those cases is asserted below.
 *
 * This module is the shared fixture harness for every file in this folder —
 * it carries no tests of its own. `livePreview.ts` is on its way to becoming a
 * facade with the same exports (see the pull request that turns it into one);
 * every file here keeps importing from this same path so that move does not
 * touch this suite.
 */

import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import {
  decorationsFor,
  editorEngaged,
  fenceHighlightStyle,
  engageEditor,
  frontmatterBlock,
  frontmatterRange,
  completedTasks,
  hangingIndents,
  HtmlPreviewWidget,
  htmlPreviews,
  livePreviewStyles,
  listGlyphs,
  markdownLanguage,
  hiddenMarkRanges,
  previewDocument,
  selectionTouches,
  styleClassFor,
  tableGrids,
  tableLines,
} from "../../features/console/files/livePreview";
import { openingCaret } from "../../features/console/files/editorSetup";

export {
  decorationsFor,
  editorEngaged,
  fenceHighlightStyle,
  engageEditor,
  frontmatterBlock,
  frontmatterRange,
  completedTasks,
  hangingIndents,
  HtmlPreviewWidget,
  htmlPreviews,
  livePreviewStyles,
  listGlyphs,
  markdownLanguage,
  hiddenMarkRanges,
  previewDocument,
  selectionTouches,
  styleClassFor,
  tableGrids,
  tableLines,
  openingCaret,
  EditorState,
  syntaxTree,
};

/**
 * Positions are clamped to the document, so a test can say "cursor far away"
 * as `100` without every case having to know how long its own fixture is.
 */
export function stateFor(doc: string, cursor?: number | [number, number]): EditorState {
  const at = (n: number) => Math.max(0, Math.min(n, doc.length));
  const selection =
    cursor === undefined
      ? undefined
      : typeof cursor === "number"
        ? { anchor: at(cursor) }
        : { anchor: at(cursor[0]), head: at(cursor[1]) };
  return EditorState.create({
    doc,
    extensions: [markdownLanguage()],
    ...(selection ? { selection } : {}),
  });
}

/**
 * The same document, read-only — reading mode, `privacy.md`, an encrypted note.
 *
 * `EditorState.readOnly` rather than a flag of the extension's own, because
 * that is the condition `revealSelection` asks about and there must not be a
 * second one for the two to disagree over.
 */
export function readingStateFor(doc: string, cursor?: number): EditorState {
  const state = stateFor(doc, cursor);
  return EditorState.create({
    doc: state.doc,
    selection: state.selection,
    extensions: [markdownLanguage(), EditorState.readOnly.of(true)],
  });
}

/**
 * What the reader actually sees: the document with every hidden range removed.
 *
 * Asserting on this rather than on the list of hidden strings is what would
 * have caught the two bugs above. "The brackets are hidden" was true while
 * `proposal.md` sat visible next to the label.
 */
export function visibleText(doc: string, cursor?: number | [number, number]): string {
  const state = stateFor(doc, cursor);
  const selection = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const hidden = hiddenMarkRanges(
    syntaxTree(state),
    selection,
    state.doc.length,
    state.doc,
  );
  let out = "";
  let at = 0;
  for (const range of [...hidden].sort((a, b) => a.from - b.from)) {
    out += state.doc.sliceString(at, range.from);
    at = Math.max(at, range.to);
  }
  return out + state.doc.sliceString(at);
}

/** The text actually hidden from the reader, as strings. */
export function hiddenText(doc: string, cursor?: number | [number, number]): string[] {
  const state = stateFor(doc, cursor);
  const selection = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  return hiddenMarkRanges(
    syntaxTree(state),
    selection,
    state.doc.length,
    state.doc,
  ).map((range) => state.doc.sliceString(range.from, range.to));
}
