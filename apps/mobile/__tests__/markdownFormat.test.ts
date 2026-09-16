/**
 * @jest-environment jsdom
 */

/**
 * THE FORMATTING VERBS, AGAINST A REAL EDITOR.
 *
 * jsdom rather than plain node because these are CodeMirror *commands*: they
 * take an `EditorView`, dispatch a transaction, and the thing worth asserting
 * is as much where the selection ends up as what the text says. A hand-rolled
 * string test would pass over the one class of bug that actually reaches
 * somebody — the second press of ⌘B landing on positions the first press moved.
 *
 * The view is built with no `parent`, so nothing is laid out and nothing is
 * painted; CodeMirror's document, selection and transaction machinery are all
 * real, which is the part under test.
 */

import { describe, expect, test } from "@jest/globals";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editability } from "../features/console/files/editorSetup";
import { MARKERS, insertTable, toggleWrap } from "../features/console/files/markdownFormat";

function editor(doc: string, options: { editable?: boolean; multiple?: boolean } = {}): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        editability(options.editable ?? true),
        /*
          Off by default, exactly as the note editor has it: `editorExtensions`
          does not enable `allowMultipleSelections`, so `EditorState` silently
          keeps only the first range and a multi-cursor test would assert
          nothing. The two tests that want more than one cursor turn it on and
          say why.
        */
        ...(options.multiple === true ? [EditorState.allowMultipleSelections.of(true)] : []),
      ],
    }),
  });
}

/** `a|b` marks a caret; `a[bc]d` marks a selection. Returns the plain text. */
function select(view: EditorView, from: number, to = from): void {
  view.dispatch({ selection: EditorSelection.single(from, to) });
}

const BOLD = MARKERS.bold;

describe("toggleWrap puts markers on", () => {
  test("around a selection, leaving the selected text selected", () => {
    const view = editor("some words here");
    select(view, 5, 10);
    toggleWrap(view, BOLD.before, BOLD.after);

    expect(view.state.doc.toString()).toBe("some **words** here");
    // The word, not the markers: a second press has to see the same thing the
    // first press acted on, or ⌘B ⌘B is not the identity.
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "words",
    );
    view.destroy();
  });

  test("around the word the caret is in, when nothing is selected", () => {
    const view = editor("some words here");
    select(view, 7);
    toggleWrap(view, BOLD.before, BOLD.after);

    expect(view.state.doc.toString()).toBe("some **words** here");
    view.destroy();
  });

  test("as a bare pair with the caret between them, on whitespace", () => {
    const view = editor("some  here");
    select(view, 5);
    toggleWrap(view, BOLD.before, BOLD.after);

    expect(view.state.doc.toString()).toBe("some **** here");
    expect(view.state.selection.main.head).toBe(7);
    expect(view.state.selection.main.empty).toBe(true);
    view.destroy();
  });
});

describe("and takes them off again, which is the whole point of ⌘B", () => {
  test("a second press on what the first press wrapped is the identity", () => {
    const view = editor("some words here");
    select(view, 5, 10);
    toggleWrap(view, BOLD.before, BOLD.after);
    toggleWrap(view, BOLD.before, BOLD.after);

    expect(view.state.doc.toString()).toBe("some words here");
    view.destroy();
  });

  test("with the markers outside the selection — a double-clicked bold word", () => {
    const view = editor("some **words** here");
    select(view, 7, 12);
    toggleWrap(view, BOLD.before, BOLD.after);

    expect(view.state.doc.toString()).toBe("some words here");
    view.destroy();
  });

  test("with the markers inside the selection — a drag across the whole span", () => {
    const view = editor("some **words** here");
    select(view, 5, 14);
    toggleWrap(view, BOLD.before, BOLD.after);

    expect(view.state.doc.toString()).toBe("some words here");
    view.destroy();
  });

  test("with the caret merely inside the bold word", () => {
    const view = editor("some **words** here");
    select(view, 9);
    toggleWrap(view, BOLD.before, BOLD.after);

    expect(view.state.doc.toString()).toBe("some words here");
    view.destroy();
  });

  test("and an empty pair the caret is sitting inside", () => {
    // `some **|** here` — what one press on an empty spot leaves behind.
    const view = editor("some **** here");
    select(view, 7);
    toggleWrap(view, BOLD.before, BOLD.after);

    expect(view.state.doc.toString()).toBe("some  here");
    view.destroy();
  });

  /**
   * ⌘B and ⌘I compose, and each takes back only its own pair.
   *
   * The failure this replaced was silent and changed what the note said:
   * `**words**` has a `*` immediately either side of the word, so ⌘I read that
   * as its own marker, took one off each end, and turned bold text into italic.
   */
  test("bold and italic compose into ***both*** and come apart again", () => {
    const view = editor("some words here");
    select(view, 5, 10);
    toggleWrap(view, BOLD.before, BOLD.after);
    toggleWrap(view, MARKERS.italic.before, MARKERS.italic.after);
    expect(view.state.doc.toString()).toBe("some ***words*** here");

    toggleWrap(view, BOLD.before, BOLD.after);
    expect(view.state.doc.toString()).toBe("some *words* here");

    toggleWrap(view, MARKERS.italic.before, MARKERS.italic.after);
    expect(view.state.doc.toString()).toBe("some words here");
    view.destroy();
  });

  test("italic does not mistake a bold pair for its own", () => {
    const view = editor("some **words** here");
    select(view, 7, 12);
    toggleWrap(view, MARKERS.italic.before, MARKERS.italic.after);

    // The `*` either side is the inner half of a `**`, and taking one off each
    // end would leave `*words*` inside a broken pair. It wraps instead.
    expect(view.state.doc.toString()).toBe("some ***words*** here");
    view.destroy();
  });
});

/**
 * A document with more than one cursor in it is an ordinary CodeMirror
 * document, and the interesting failure is not the arithmetic — `changeByRange`
 * handles that — but the *decision*: per-range answers produce a press that
 * bolds one place and unbolds another, which no second press undoes.
 */
describe("a multi-cursor selection decides once for the document", () => {
  /*
    `allowMultipleSelections` is **not** on in the note editor today, so nobody
    can reach this by pressing anything. It is tested because the commands are
    written with `changeByRange` — one dispatch for every range, because two
    dispatches would apply the second against positions the first had already
    moved — and a rule written for a case that cannot happen yet is a rule that
    is wrong the day it can. The cost of checking it now is this facet.
  */
  test("every range gets markers when the ranges disagree", () => {
    const view = editor("**one** two", { multiple: true });
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(2, 5),
        EditorSelection.range(8, 11),
      ]),
    });
    toggleWrap(view, BOLD.before, BOLD.after);

    expect(view.state.doc.toString()).toBe("****one**** **two**");
    view.destroy();
  });

  test("and markers come off only when every range already has them", () => {
    const view = editor("**one** **two**", { multiple: true });
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(2, 5),
        EditorSelection.range(10, 13),
      ]),
    });
    toggleWrap(view, BOLD.before, BOLD.after);

    expect(view.state.doc.toString()).toBe("one two");
    view.destroy();
  });
});

describe("a read-only note refuses every one of them", () => {
  /**
   * Not because `toggleWrap` checks — it does not, deliberately; its callers
   * refuse before dispatching so the key is *inert* rather than merely
   * harmless. This is the last gate, `editability`'s `changeFilter`, and it is
   * the one that holds when a caller forgets. See `editorSetup.ts`.
   */
  test("the changeFilter drops the transaction even when the command runs", () => {
    const view = editor("some words here", { editable: false });
    select(view, 5, 10);
    toggleWrap(view, BOLD.before, BOLD.after);

    expect(view.state.doc.toString()).toBe("some words here");
    view.destroy();
  });
});

describe("insertTable writes a table the grammar will accept", () => {
  test("a header row, a delimiter row, and the body rows asked for", () => {
    const view = editor("");
    insertTable(view, 2, 3);

    expect(view.state.doc.toString()).toBe(
      "|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n",
    );
    view.destroy();
  });

  test("the caret lands in the first header cell, not on a pipe", () => {
    const view = editor("");
    insertTable(view, 1, 2);

    expect(view.state.selection.main.head).toBe(2);
    expect(view.state.sliceDoc(0, 2)).toBe("| ");
    view.destroy();
  });

  /**
   * A GFM table cannot interrupt a paragraph: a delimiter row directly under a
   * line of prose is parsed as more prose, and what somebody gets for pressing
   * the button is a row of literal pipes in the middle of their sentence.
   */
  test("a table asked for on a line with text goes after the paragraph", () => {
    const view = editor("Some prose.");
    select(view, 5);
    insertTable(view, 0, 1);

    expect(view.state.doc.toString()).toBe("Some prose.\n\n|     |\n| --- |\n");
    view.destroy();
  });

  test("and lands where the caret is on an empty line", () => {
    const view = editor("Some prose.\n\n");
    select(view, 13);
    insertTable(view, 0, 1);

    expect(view.state.doc.toString()).toBe("Some prose.\n\n|     |\n| --- |\n");
    view.destroy();
  });

  test("a zero-column table is not a thing that can be asked for", () => {
    const view = editor("");
    insertTable(view, 0, 0);

    expect(view.state.doc.toString()).toBe("|     |\n| --- |\n");
    view.destroy();
  });

  test("and a read-only note gets no table either", () => {
    const view = editor("", { editable: false });
    insertTable(view, 2, 2);

    expect(view.state.doc.toString()).toBe("");
    view.destroy();
  });
});
