/**
 * A new note's title line, as board 3 draws it (`meeting-2026-10-17/
 * phone-inbox/`, approved by Dev2 on 2026-10-17): a grey **Title** where the
 * placeholder name is, and under it one line saying what happens next — "Your
 * agent will file it" for a note in the Inbox.
 *
 * The file still says `# untitled-2026-10-17`: that is what names a note
 * before anybody has (`untitled.ts`), and the heading is what renames it once
 * somebody types one (`useLinkedTitle.ts`). This only changes how that line is
 * *drawn* while it still says the placeholder: the line's words are drawn as
 * "Title", and the first keystroke makes it the person's own words, drawn as
 * themselves.
 *
 * That first keystroke replaces the placeholder whatever the selection is.
 * Opening a new note selects the title's words, but a tap or click on the grey
 * "Title" — the obvious place to start typing — collapses that selection to
 * the end of the line, and typing there appended to a name nobody could see:
 * `# untitled-2026-10-19Is` (reported 2026-10-19). So typing or pasting into a
 * placeholder title replaces its words, and a backspace in it does nothing, as
 * in an empty field: there is nothing on screen to delete.
 *
 * Both editors install it from `editorExtensions`, and the line under the
 * title comes in as a command (`titleHint`), so the phone's web view and the
 * web editor draw the same thing from the same code.
 */
import {
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { titleRange } from "./liveEditorWeb/titleLine";

/** `untitled-2026-10-17`, `untitled-2026-10-17-2`: `untitledStem` and its suffix. */
const PLACEHOLDER = /^untitled-\d{4}-\d{2}-\d{2}(-\d+)?$/;

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

/** Where the placeholder title is, when the note's title still is one. */
export function placeholderTitle(state: EditorState): { from: number; to: number; textFrom: number } | null {
  const range = titleRange(state);
  if (range === null) return null;
  const words = state.doc.sliceString(range.textFrom, range.to).trim();
  return PLACEHOLDER.test(words) ? range : null;
}

/**
 * The person's own edit to a placeholder title, made to the whole placeholder:
 * text typed, pasted or dropped anywhere in the line replaces its words, and a
 * deletion inside it does not happen. Only the person's own input — a collaborator's
 * change or a rename arriving from the host is applied as it came.
 */
function replacePlaceholder(transaction: Transaction): Transaction | readonly TransactionSpec[] {
  if (!transaction.docChanged) return transaction;
  const typing = transaction.isUserEvent("input");
  if (!typing && !transaction.isUserEvent("delete")) return transaction;
  const range = placeholderTitle(transaction.startState);
  if (range === null) return transaction;
  let inserted = "";
  let inside = true;
  transaction.changes.iterChanges((from, to, _fromB, _toB, text) => {
    if (from < range.from || to > range.to) inside = false;
    inserted += text.toString();
  });
  // Enter at the end of the title starts the body, and a change reaching past
  // the line (select-all, a multi-line paste over it) is not a retitle.
  if (!inside || inserted.includes("\n")) return transaction;
  if (!typing) return [];
  return [
    {
      changes: { from: range.textFrom, to: range.to, insert: inserted },
      selection: EditorSelection.cursor(range.textFrom + inserted.length),
      userEvent: transaction.annotation(Transaction.userEvent),
      scrollIntoView: transaction.scrollIntoView,
    },
  ];
}

function decorate(state: EditorState, hint: string | null): DecorationSet {
  const range = titleRange(state);
  if (range === null) return Decoration.none;
  const marks = [];
  const placeholder = placeholderTitle(state);
  // The whole line, its `# ` included: board 3 draws the word alone.
  if (placeholder !== null) marks.push(Decoration.replace({ widget: new PlaceholderTitle() }).range(range.from, range.to));
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
  return [field, EditorState.transactionFilter.of(replacePlaceholder)];
}

/** Draw `text` under the title of a note that has none yet, or clear it. */
export function showTitleHint(view: EditorView, text: string | null): void {
  if ((view.state.field(field, false)?.hint ?? null) === text) return;
  view.dispatch({ effects: setTitleHint.of(text) });
}
