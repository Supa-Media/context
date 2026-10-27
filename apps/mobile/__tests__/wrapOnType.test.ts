/**
 * @jest-environment jsdom
 */

/**
 * Typing a markdown mark over selected words wraps them instead of replacing
 * them — `[` twice makes a `[[link]]`, `*` twice makes bold, the way Obsidian
 * and every other markdown editor people come from behave.
 *
 * What has to hold: each mark wraps and keeps the same words selected, so the
 * second press wraps again; several selections all wrap in one change; an
 * empty selection, an ordinary character and a paste are left to the
 * browser.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";

import { WRAP_PAIRS, wrapOnType } from "../features/console/files/wrapOnType";
import { Compartment, editorExtensions } from "../features/console/files/editorSetup";

const views: EditorView[] = [];
afterEach(() => {
  while (views.length > 0) views.pop()?.destroy();
});

function mount(doc: string, selection: EditorSelection, extensions = [wrapOnType()]): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection,
      extensions: [EditorState.allowMultipleSelections.of(true), ...extensions],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

/** What the browser does when a key is typed: the input handlers first. */
function type(view: EditorView, text: string): void {
  const { from, to } = view.state.selection.main;
  const handled = view.state
    .facet(EditorView.inputHandler)
    .some((handler) => handler(view, from, to, text, () => view.state.update({ changes: { from, to, insert: text } })));
  if (!handled) view.dispatch(view.state.replaceSelection(text));
}

function selected(view: EditorView): string[] {
  return view.state.selection.ranges.map((range) => view.state.sliceDoc(range.from, range.to));
}

describe("a mark typed over selected words", () => {
  test("[ twice makes a linked note from the words", () => {
    const view = mount("meet Ruth today", EditorSelection.single(5, 9));
    type(view, "[");
    expect(view.state.doc.toString()).toBe("meet [Ruth] today");
    type(view, "[");
    expect(view.state.doc.toString()).toBe("meet [[Ruth]] today");
    expect(selected(view)).toEqual(["Ruth"]);
  });

  test.each([
    ["*", "**", "a **word** here"],
    ["=", "==", "a ==word== here"],
    ["~", "~~", "a ~~word~~ here"],
    ["_", "_", "a _word_ here"],
    ["`", "`", "a `word` here"],
  ])("%s wraps, and a second press wraps again", (key, twice, after) => {
    const view = mount("a word here", EditorSelection.single(2, 6));
    for (const _ of twice) type(view, key);
    expect(view.state.doc.toString()).toBe(after);
    expect(selected(view)).toEqual(["word"]);
  });

  test("every pair it knows closes with its own partner", () => {
    expect(WRAP_PAIRS).toMatchObject({ "[": "]", "(": ")", "*": "*", "_": "_", "=": "=", "~": "~", "`": "`" });
  });

  test("a backwards selection stays backwards", () => {
    const view = mount("a word here", EditorSelection.single(6, 2));
    type(view, "*");
    const range = view.state.selection.main;
    expect([range.anchor, range.head]).toEqual([7, 3]);
  });

  test("several selections wrap in one change, undone in one step", () => {
    const view = mount("one two three", EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(8, 13)]));
    type(view, "=");
    type(view, "=");
    expect(view.state.doc.toString()).toBe("==one== two ==three==");
    expect(selected(view)).toEqual(["one", "three"]);
  });

  test("undo puts the words back", () => {
    const view = mount("a word here", EditorSelection.single(2, 6), [wrapOnType(), history()]);
    type(view, "*");
    undo(view);
    expect(view.state.doc.toString()).toBe("a word here");
  });
});

describe("what it leaves alone", () => {
  test("a mark with nothing selected is typed as itself", () => {
    const view = mount("a word", EditorSelection.single(6));
    type(view, "*");
    expect(view.state.doc.toString()).toBe("a word*");
  });

  test("any other character still replaces the selection", () => {
    const view = mount("a word here", EditorSelection.single(2, 6));
    type(view, "x");
    expect(view.state.doc.toString()).toBe("a x here");
  });

  test("a paste or a longer input is not a mark", () => {
    const view = mount("a word here", EditorSelection.single(2, 6));
    type(view, "**");
    expect(view.state.doc.toString()).toBe("a ** here");
  });
});

describe("in the editor every surface uses", () => {
  test("the web, Mac and phone editor wrap a selection typed over", () => {
    const view = mount(
      "meet Ruth today",
      EditorSelection.single(5, 9),
      editorExtensions({ editable: true, editableCompartment: new Compartment(), handlers: { current: { onChange: () => {}, onSave: () => {} } } }),
    );
    type(view, "[");
    type(view, "[");
    expect(view.state.doc.toString()).toBe("meet [[Ruth]] today");
  });
});
