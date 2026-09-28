/**
 * The note's title, as the web editor sees it: where it is, whether the caret
 * is in it, and the one line drawn under it.
 *
 * The other half of `fileBrowser/useLinkedTitle.ts`. That hook decides when a
 * title renames its file — on leaving it — and this is how the editor says
 * "left": the caret is in the title while the editor has focus and the
 * selection's head is on the title's line. Web only, like `findInNote`: the
 * native editor reports focus over its bridge and nothing finer, and the hook
 * treats a surface that says nothing as one whose caret is never in the title.
 *
 * The line under the title is the design's only new pixels (`rename-flow-
 * artboards`, frame 05): a name that is taken, or a share that holds the path,
 * said where the person is typing rather than in a notice across the window.
 * A block widget rather than React drawn over the editor, so it moves with the
 * title — wrapped titles, frontmatter folding open above it — without anybody
 * measuring anything.
 */

import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

/** Where the title is: the whole line, and where its words start after `# `. */
export function titleRange(state: EditorState): { from: number; to: number; textFrom: number } | null {
  const doc = state.doc;
  let number = 1;
  // Frontmatter first, as `titleFor` skips it — the two must agree on which
  // line is the title, or the caret is "in the title" on a line the rename
  // does not read.
  if (doc.lines >= 1 && doc.line(1).text.trim() === "---") {
    number = 2;
    while (number <= doc.lines && doc.line(number).text.trim() !== "---") number += 1;
    number += 1;
  }
  while (number <= doc.lines && doc.line(number).text.trim() === "") number += 1;
  if (number > doc.lines) return null;
  const line = doc.line(number);
  const heading = /^(\s*#\s+)/.exec(line.text);
  if (heading === null) return null;
  return { from: line.from, to: line.to, textFrom: line.from + heading[1]!.length };
}

export type TitleNote = { tone: "problem" | "held"; message: string } | null;

const setTitleNote = StateEffect.define<TitleNote>();

class TitleNoteWidget extends WidgetType {
  constructor(readonly note: NonNullable<TitleNote>) {
    super();
  }

  eq(other: TitleNoteWidget): boolean {
    return other.note.tone === this.note.tone && other.note.message === this.note.message;
  }

  toDOM(): HTMLElement {
    const line = document.createElement("div");
    line.className = `cm-lp-title-note cm-lp-title-note-${this.note.tone}`;
    line.setAttribute("role", "status");
    line.textContent = this.note.message;
    return line;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const titleNoteField = StateField.define<{ note: TitleNote; decorations: DecorationSet }>({
  create: () => ({ note: null, decorations: Decoration.none }),
  update(value, transaction) {
    let note = value.note;
    for (const effect of transaction.effects) if (effect.is(setTitleNote)) note = effect.value;
    if (note === value.note && !transaction.docChanged) return value;
    const range = note === null ? null : titleRange(transaction.state);
    const decorations =
      note === null || range === null
        ? Decoration.none
        : Decoration.set([
            Decoration.widget({ widget: new TitleNoteWidget(note), block: true, side: 1 }).range(range.to),
          ]);
    return { note, decorations };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/**
 * The title's two pieces of state: the line under it, and the caret in it.
 *
 * `report` is read at call time, for the reason every callback into this view
 * is — the view is built once and would otherwise report to the first render
 * forever. It is told only when the answer changes.
 */
export function titleLine(report: () => ((inTitle: boolean) => void) | undefined) {
  let last = false;
  return [
    titleNoteField,
    EditorView.updateListener.of((update) => {
      if (!update.selectionSet && !update.focusChanged && !update.docChanged) return;
      const range = titleRange(update.state);
      const head = update.state.selection.main.head;
      const inTitle = update.view.hasFocus && range !== null && head >= range.from && head <= range.to;
      if (inTitle === last) return;
      last = inTitle;
      report()?.(inTitle);
    }),
  ];
}

/** Draw `note` under the title, or clear it. */
export function showTitleNote(view: EditorView, note: TitleNote): void {
  const current = view.state.field(titleNoteField, false)?.note ?? null;
  if (current === note) return;
  if (current !== null && note !== null && current.tone === note.tone && current.message === note.message) return;
  view.dispatch({ effects: setTitleNote.of(note) });
}

/**
 * Put the caret in the title with its words selected — Rename on the row of
 * the open note, and a new note's placeholder, which the first keystroke then
 * replaces. `false` when there is no title to go to.
 */
export function selectTitle(view: EditorView): boolean {
  const range = titleRange(view.state);
  if (range === null) return false;
  view.dispatch({ selection: { anchor: range.textFrom, head: range.to }, scrollIntoView: true });
  view.focus();
  return true;
}
