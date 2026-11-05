/**
 * A new note's title line, as board 3 draws it (`meeting-2026-10-17/
 * phone-inbox/`, approved by Dev2 on 2026-10-17): a grey **Title** where the
 * title goes, and under it one line saying what happens next — "Your agent
 * will file it" for a note in the Inbox.
 *
 * ## The title is empty, and nothing stands in for it in the text
 *
 * A new note's text starts as `# ` and an empty line: a heading with no words
 * yet. Its made-up name, `untitled-2026-11-05`, is the file's name on its row
 * (`untitled.ts`) and nowhere in the note. The grey "Title" is drawn into the
 * empty heading, and what is typed there is the title, by the editor's own
 * ordinary typing. The heading renames the file once it has words
 * (`useLinkedTitle.ts`).
 *
 * Until 2026-11-05 the text said `# untitled-2026-11-05` and this file drew
 * that line as "Title" and guessed, from each typed change, which part was the
 * person's. A browser typing over the selected words of a line drawn as
 * something else hands CodeMirror the old words with the new letter on the end,
 * and the guess took the lot: `# untitled-2026-10-19Is` (2026-10-19), then
 * `# untitled-2026-11-04-2S` (2026-11-05) with the title selected on opening.
 * Dev2 picked removing the stand-in text over patching the guess again. With
 * nothing in the line, there is nothing to guess about.
 *
 * A backspace in the empty title does nothing, as in an empty field: there is
 * nothing on screen to delete, and taking the `#` would leave a note whose
 * first line is not its title.
 *
 * Both editors install it from `editorExtensions`, and the line under the
 * title comes in as a command (`titleHint`), so the phone's web view and the
 * web editor draw the same thing from the same code.
 */
import { EditorState, StateEffect, StateField, type Extension, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { titleRange } from "./liveEditorWeb/titleLine";

export const TITLE_PLACEHOLDER = "Title";

/** The line under a new note's title, or `null` for none. */
export const setTitleHint = StateEffect.define<string | null>();

class PlaceholderTitle extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const word = document.createElement("span");
    // `cm-lp-h1` is what the heading's own mark drew before this replaced it:
    // the same size and weight as the title it stands for, only greyed.
    word.className = "cm-lp-h1 cm-untitled-title";
    // The heading's own ink, faded: --lp-muted is near-black on a phone (it is
    // the second text colour there), so it cannot say "placeholder" by itself.
    // Board 3's grey is the ink at about 40%, in either theme.
    word.style.opacity = "0.4";
    word.textContent = TITLE_PLACEHOLDER;
    return word;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class TitleHint extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: TitleHint): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const line = document.createElement("div");
    line.className = "cm-untitled-hint";
    // Inline rather than a theme: the note's own sheets set the face and size
    // of everything in the content, and this line is the app talking, not the
    // note — the interface face, small and grey, as board 3 draws it.
    Object.assign(line.style, {
      opacity: "0.65",
      fontFamily: "-apple-system, system-ui, sans-serif",
      fontSize: "15px",
      fontWeight: "400",
      lineHeight: "1.4",
      padding: "2px 0 8px",
    });
    line.textContent = this.text;
    return line;
  }
}

/** Where the empty title is, while the note's title has no words yet. */
export function emptyTitle(state: EditorState): { from: number; to: number; textFrom: number } | null {
  const range = titleRange(state);
  if (range === null) return null;
  return state.doc.sliceString(range.textFrom, range.to).trim() === "" ? range : null;
}

/** A backspace or delete made inside the empty title, which has nothing to delete. */
function keepEmptyTitle(transaction: Transaction): Transaction | readonly [] {
  if (!transaction.docChanged || !transaction.isUserEvent("delete")) return transaction;
  const range = emptyTitle(transaction.startState);
  if (range === null) return transaction;
  let inside = true;
  transaction.changes.iterChanges((from, to) => {
    if (from < range.from || to > range.to) inside = false;
  });
  return inside ? [] : transaction;
}

function decorate(state: EditorState, hint: string | null): DecorationSet {
  const range = titleRange(state);
  if (range === null) return Decoration.none;
  const marks = [];
  const empty = emptyTitle(state);
  // Board 3 draws the word alone: the `# ` is hidden and "Title" drawn after
  // it, as a widget beside the caret rather than over any text, so typing
  // there is typing into an empty line.
  if (empty !== null) {
    marks.push(Decoration.replace({}).range(empty.from, empty.to));
    marks.push(Decoration.widget({ widget: new PlaceholderTitle(), side: 1 }).range(empty.to));
  }
  // Only while nothing has been written under the title: it is a note about a
  // new note, and a note with words in it is not one any more.
  const rest = state.doc.sliceString(range.to).trim();
  if (hint !== null && rest === "") {
    marks.push(Decoration.widget({ widget: new TitleHint(hint), block: true, side: 1 }).range(range.to));
  }
  return Decoration.set(marks, true);
}

const field = StateField.define<{ hint: string | null; decorations: DecorationSet }>({
  create: (state) => ({ hint: null, decorations: decorate(state, null) }),
  update(value, transaction) {
    let hint = value.hint;
    for (const effect of transaction.effects) if (effect.is(setTitleHint)) hint = effect.value;
    if (hint === value.hint && !transaction.docChanged) return value;
    return { hint, decorations: decorate(transaction.state, hint) };
  },
  provide: (self) => EditorView.decorations.from(self, (value) => value.decorations),
});

export function untitledTitle(): Extension {
  return [field, EditorState.transactionFilter.of(keepEmptyTitle)];
}

/** Draw `text` under the title of a note that has none yet, or clear it. */
export function showTitleHint(view: EditorView, text: string | null): void {
  if ((view.state.field(field, false)?.hint ?? null) === text) return;
  view.dispatch({ effects: setTitleHint.of(text) });
}
