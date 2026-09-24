/**
 * `editorEngaged` and the selection the reveal rule is allowed to act on.
 *
 * Defined exactly once, here. Part of the Live Preview extension;
 * `../livePreview.ts` is the facade that re-exports the public names and holds
 * the module map.
 */

import { StateEffect, StateField, type EditorState } from "@codemirror/state";

/**
 * Is somebody working in this document?
 *
 * Not "does it have the keyboard", which is what this was first written as and
 * is the wrong question by a hair that costs a feature. Focus is a fact about
 * the DOM and it moves for reasons that have nothing to do with editing: a
 * right-click menu is a React popover, and opening one blurs the editor.
 *
 * Measured in Chromium: right-click → Bold inserted the `**` correctly, and the
 * note redrew with every mark hidden, so Bold looked like it had done nothing.
 * `runMenuAction` calls `view.focus()` immediately after the command and
 * `document.activeElement` really was `.cm-content` — a blur transaction simply
 * arrived last. Chasing that ordering is a losing game; every popover, toolbar
 * and side panel this product grows would be another round of it.
 *
 * So the field is engagement, and it is one-way within a document:
 *
 *  - `false` when a note is **put on screen** — `replaceDocument` says so
 *    explicitly, which is the whole state this exists to draw.
 *  - `true` the moment somebody clicks into the text or changes it
 *    (`select.pointer`, `input`, `delete`) or focuses the editor at all.
 *  - and it does not go back on blur. Reaching for a menu is not leaving.
 *
 * A `StateEffect` and a field rather than reading `view.hasFocus`, because
 * `decorationsFor` is a pure function of `EditorState` and that is what makes
 * it testable at all.
 */
export const setEditorEngaged = StateEffect.define<boolean>();

/**
 * Engage or disengage the document. Exported for its two callers:
 * `replaceDocument`, which closes the gate on every note it opens, and
 * `livePreview.test.ts`, which has no view to click in.
 */
export function engageEditor(engaged: boolean) {
  return setEditorEngaged.of(engaged);
}

/** Starts closed: a document that has just been put on screen is untouched. */
export const editorEngaged = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setEditorEngaged)) return effect.value;
    }
    /*
      A pointer selection is a click inside the text; `input` and `delete` are
      edits, including the ones a menu command dispatches. None of them is
      `replaceDocument` opening a note, which carries no user event and closes
      the gate explicitly anyway.
    */
    if (
      transaction.isUserEvent("select.pointer") ||
      transaction.isUserEvent("input") ||
      transaction.isUserEvent("delete")
    ) {
      return true;
    }
    return value;
  },
});

/**
 * The selection the reveal rule may act on.
 *
 * NOTHING REVEALS IN A DOCUMENT NOBODY CAN TYPE INTO. Markup comes back when
 * the caret enters it, because you cannot edit syntax you cannot see. A
 * read-only document has no caret to enter anything with — `editability` drops
 * `contenteditable` — but `state.selection` is still a range at 0, so the
 * note's first construct would draw its own asterisks at a reader who cannot
 * act on them, and an HTML preview at the top of a note would sit there as its
 * own source.
 *
 * So read-only is an empty selection, which is the same sentence the reveal
 * rule already makes: reveal for editing, and there is no editing. One
 * condition covers reading mode, `privacy.md` and an encrypted envelope, and it
 * is `state.readOnly` rather than a flag of this extension's own so there is
 * nothing for the two to disagree about.
 *
 * Both callers take it from here rather than each mapping the ranges, because
 * the two are one rule: `htmlPreviews` withdrawing a preview while
 * `decorationsFor` keeps the markup hidden is a half-revealed note.
 *
 * ## AND NOTHING REVEALS IN A DOCUMENT NOBODY HAS TOUCHED
 *
 * The same sentence, one step weaker, and it is the half that was missing. A
 * caret exists the moment the document does — at 0, or wherever
 * `replaceDocument` put it — whether or not anybody has gone near the editor.
 * So a note *opened* rather than edited drew the markup of whichever construct
 * the caret happened to land in, at a reader who had not touched anything.
 *
 * That is not hypothetical and it is how this was found: `openingCaret` puts
 * the caret past the frontmatter, which is the first line of the writing — and
 * on a note that opens with `# Title`, which is most of them, the page's title
 * rendered as `# Title` with the hash showing. The canvas draws it clean, and
 * so does every editor with a live preview: markup comes back **where you are
 * working**, and a person who has not touched the note is not working
 * anywhere.
 *
 * `editorEngaged` is what that reads, and its own comment argues why it is
 * engagement rather than DOM focus — the short version being that a right-click
 * menu blurs the editor and Bold would have appeared to do nothing.
 *
 * A state with no such field — every direct `decorationsFor` call in the unit
 * suite, and any configuration that does not install `livePreview` — reveals
 * as it always did. The gate is something the extension opts into, so a test
 * that builds a bare `EditorState` to ask what a construct looks like still
 * gets an answer about the construct.
 */
export function revealSelection(state: EditorState): Array<{ from: number; to: number }> {
  if (state.readOnly) return [];
  if ((state.field(editorEngaged, false) ?? true) === false) return [];
  return state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
}
