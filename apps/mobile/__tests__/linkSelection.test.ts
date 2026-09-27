/**
 * @jest-environment jsdom
 */

/**
 * THE LINK KEY OVER SELECTED WORDS, AGAINST A REAL EDITOR.
 *
 * `runCommand` is what both surfaces call — the web editor directly, the iOS
 * guest over the bridge — so this drives it against a real `EditorView`:
 * press the key with words selected, answer the ask, and read the document.
 *
 * What would cost somebody their text is pinned hardest: the key used to
 * delete the selection, so a press that opens the sheet must change nothing;
 * a cancel must put the selection back exactly; and a pick must write over
 * the words that were selected even if the note moved underneath in the
 * meantime — and must *not* write over words that are no longer there.
 */

import { describe, expect, test } from "@jest/globals";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { runCommand } from "../features/console/files/editorSetup";
import type { LinkTarget } from "../features/console/files/linkMarkdown";

function editor(doc: string, selection: EditorSelection, editable = true) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection,
      extensions: [EditorState.allowMultipleSelections.of(true), EditorState.readOnly.of(!editable)],
    }),
  });
  const asked: string[] = [];
  const press = () => runCommand(view, { name: "insertLink" }, (text) => asked.push(text));
  return { view, asked, press, text: () => view.state.doc.toString() };
}

const DOC = "Read the launch plan before standup.";
const WORDS = "the launch plan";
const AT = DOC.indexOf(WORDS);
const selected = EditorSelection.single(AT, AT + WORDS.length);

describe("pressing the key over selected words", () => {
  test("asks, with the words, and changes nothing yet", () => {
    const e = editor(DOC, selected);
    e.press();
    expect(e.asked).toEqual([WORDS]);
    expect(e.text()).toBe(DOC);
    expect(e.view.state.selection.main).toMatchObject({ from: AT, to: AT + WORDS.length });
  });

  test.each([
    ["a web page", { kind: "url", url: "https://example.com/launch" }, `[${WORDS}](https://example.com/launch)`],
    ["a note", { kind: "note", target: "1-projects/launch-plan" }, `[[1-projects/launch-plan|${WORDS}]]`],
    ["free text", { kind: "note", target: "launch" }, `[[launch|${WORDS}]]`],
  ] as [string, LinkTarget, string][])("then %s replaces the words with the link, caret after it", (_kind, link, written) => {
    const e = editor(DOC, selected);
    e.press();
    runCommand(e.view, { name: "applyLink", link });
    expect(e.text()).toBe(`Read ${written} before standup.`);
    expect(e.view.state.selection.main.head).toBe(AT + written.length);
    expect(e.view.state.selection.main.empty).toBe(true);
  });

  test("cancel puts the selection back exactly and writes nothing", () => {
    const e = editor(DOC, selected);
    e.press();
    e.view.dispatch({ selection: { anchor: 0 } });
    runCommand(e.view, { name: "cancelLink" });
    expect(e.text()).toBe(DOC);
    expect(e.view.state.selection.main).toMatchObject({ from: AT, to: AT + WORDS.length });
  });

  test("a second answer does nothing: the request is spent", () => {
    const e = editor(DOC, selected);
    e.press();
    runCommand(e.view, { name: "applyLink", link: { kind: "note", target: "a" } });
    const once = e.text();
    runCommand(e.view, { name: "applyLink", link: { kind: "note", target: "b" } });
    runCommand(e.view, { name: "cancelLink" });
    expect(e.text()).toBe(once);
  });
});

describe("the note moving while the sheet is open", () => {
  test("text typed above the words: the link still lands on them", () => {
    const e = editor(DOC, selected);
    e.press();
    e.view.dispatch({ changes: { from: 0, insert: "First, " } });
    runCommand(e.view, { name: "applyLink", link: { kind: "note", target: "launch" } });
    expect(e.text()).toBe(`First, Read [[launch|${WORDS}]] before standup.`);
  });

  test("the words themselves edited: they are left alone rather than overwritten", () => {
    const e = editor(DOC, selected);
    e.press();
    e.view.dispatch({ changes: { from: AT + 4, to: AT + 10, insert: "budget" } });
    const edited = e.text();
    runCommand(e.view, { name: "applyLink", link: { kind: "note", target: "launch" } });
    expect(e.text()).toBe(edited);
  });
});

describe("several cursors", () => {
  test("every range with words is linked with its own words, in one step", () => {
    const doc = "alpha and beta and gamma";
    const e = editor(
      doc,
      EditorSelection.create(
        [EditorSelection.range(0, 5), EditorSelection.cursor(9), EditorSelection.range(10, 14)],
        2,
      ),
    );
    e.press();
    // The sheet names the main range's words.
    expect(e.asked).toEqual(["beta"]);
    runCommand(e.view, { name: "applyLink", link: { kind: "url", url: "https://example.com" } });
    expect(e.text()).toBe("[alpha](https://example.com) and [beta](https://example.com) and gamma");
    // A caret after each link; the empty cursor had nothing to link.
    expect(e.view.state.selection.ranges.map((range) => range.head)).toEqual([28, 60]);
  });

  test("a main cursor with no words names the first range that has some", () => {
    const e = editor("alpha beta", EditorSelection.create([EditorSelection.range(0, 5), EditorSelection.cursor(8)], 1));
    e.press();
    expect(e.asked).toEqual(["alpha"]);
  });
});

describe("when the sheet does not open", () => {
  test("nothing selected: the key is still `[[]]` at the caret", () => {
    const e = editor(DOC, EditorSelection.single(AT));
    e.press();
    expect(e.asked).toEqual([]);
    expect(e.text()).toBe(`Read [[]]the launch plan before standup.`);
    expect(e.view.state.selection.main.head).toBe(AT + 2);
  });

  test("words no link can hold are kept, and the pair goes after them", () => {
    const doc = "one\ntwo";
    const e = editor(doc, EditorSelection.single(0, doc.length));
    e.press();
    expect(e.asked).toEqual([]);
    expect(e.text()).toBe("one\ntwo[[]]");
  });

  test("no sheet on this surface: the key does exactly what it always did", () => {
    const e = editor(DOC, selected);
    runCommand(e.view, { name: "insertLink" });
    expect(e.text()).toBe(`Read [[]] before standup.`);
  });

  test("a note this viewer may only read: nothing is asked and nothing is written", () => {
    const e = editor(DOC, selected, false);
    e.press();
    runCommand(e.view, { name: "applyLink", link: { kind: "note", target: "a" } });
    expect(e.asked).toEqual([]);
    expect(e.text()).toBe(DOC);
  });
});
