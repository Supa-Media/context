import { describe, expect, test } from "@jest/globals";
import { EditorSelection, EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { decorationsFor, engageEditor, livePreview, markdownLanguage } from "../../features/console/files/livePreview";
import { markdownShown, setMarkdownShown } from "../../features/console/files/livePreview/symbols";

/*
  A REGULAR EDITOR THAT SUPPORTS MARKDOWN, WITHOUT SHOWING IT.

  Owner, 2026-11-08: "instead of exposing a lot of markdown details, we make it
  a regular editor that supports markdown." With Show Markdown off (the
  default), the caret entering bold does not bring its `**` back, a heading
  never shows its `#`, a link never shows its address: the words are what is
  on screen, and Backspace deletes the letter you can see, never half a pair
  of marks you cannot.

  SABOTAGE: make `symbolsHidden` return false and the "never reveal" cases
  fail; drop `symbolDeletes` from `livePreview()` and the Backspace cases
  fail; drop the empty-construct check in `hiddenMarkRanges` and "a heading
  being started shows its #" fails.
*/

function stateWith(doc: string, cursor: number, shown = false): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdownLanguage(), livePreview(), markdownShown.init(() => shown)],
  });
  ensureSyntaxTree(state, state.doc.length, 10_000);
  return state.update({ effects: engageEditor(true) }).state;
}

/** The document as the reader sees it: every hidden mark taken out. */
function onScreen(state: EditorState): string {
  const hidden: Array<{ from: number; to: number }> = [];
  decorationsFor(state).between(0, state.doc.length, (from, to, value) => {
    if (from < to && value.point && (value.spec as { widget?: unknown }).widget === undefined) hidden.push({ from, to });
  });
  let out = "";
  let at = 0;
  for (const range of hidden.sort((a, b) => a.from - b.from)) {
    out += state.doc.sliceString(at, Math.max(at, range.from));
    at = Math.max(at, range.to);
  }
  return out + state.doc.sliceString(at);
}

function backspace(state: EditorState): EditorState {
  const at = state.selection.main.head;
  return state.update({
    changes: { from: at - 1, to: at },
    selection: EditorSelection.cursor(at - 1),
    userEvent: "delete.backward",
  }).state;
}

function forwardDelete(state: EditorState): EditorState {
  const at = state.selection.main.head;
  return state.update({
    changes: { from: at, to: at + 1 },
    selection: EditorSelection.cursor(at),
    userEvent: "delete.forward",
  }).state;
}

describe("with Show Markdown off, the caret never brings symbols back", () => {
  test("bold, italic, a link and a heading stay drawn under the caret", () => {
    const doc = "# Plan\n\nplant **basil** and *mint* near [the door](door.md)\n\nend";
    for (const cursor of [3, doc.indexOf("basil") + 2, doc.indexOf("mint") + 1, doc.indexOf("door]") + 1]) {
      expect(onScreen(stateWith(doc, cursor))).toBe("Plan\n\nplant basil and mint near the door\n\nend");
    }
  });

  test("a wiki link is its name under the caret too", () => {
    const doc = "see [[areas/garden/Basil]] today\n\nend";
    expect(onScreen(stateWith(doc, doc.indexOf("Basil") + 2))).toBe("see Basil today\n\nend");
  });

  test("Show Markdown on is the reveal rule as it always was", () => {
    const doc = "plant **basil** now\n\nend";
    expect(onScreen(stateWith(doc, doc.indexOf("basil") + 2, true))).toBe("plant **basil** now\n\nend");
  });

  test("the switch takes effect on an open note", () => {
    const doc = "plant **basil** now\n\nend";
    const shown = stateWith(doc, doc.indexOf("basil") + 2, true);
    expect(onScreen(shown.update({ effects: setMarkdownShown.of(false) }).state)).toBe("plant basil now\n\nend");
  });

  test("a heading being started shows its # until it has words", () => {
    expect(onScreen(stateWith("#\n\nend", 1))).toBe("#\n\nend");
    expect(onScreen(stateWith("# \n\nend", 2))).toBe("# \n\nend");
    expect(onScreen(stateWith("# H\n\nend", 3))).toBe("H\n\nend");
  });

  test("a code block's fences still come back to be edited", () => {
    const doc = "```\ncode\n```\n\nend";
    expect(onScreen(stateWith(doc, 5))).toBe(doc);
  });
});

describe("Backspace deletes the letter you can see", () => {
  test("after bold: the last letter, and the word stays bold", () => {
    const doc = "plant **basil** now";
    const after = backspace(stateWith(doc, doc.indexOf(" now")));
    expect(after.doc.toString()).toBe("plant **basi** now");
    expect(after.selection.main.head).toBe(doc.indexOf("l**"));
  });

  test("the last letter of a bold word takes the bold with it", () => {
    const doc = "plant **b** now";
    expect(backspace(stateWith(doc, doc.indexOf(" now"))).doc.toString()).toBe("plant  now");
  });

  test("the last letter, deleted from inside the bold, takes the bold too", () => {
    const doc = "plant **b** now";
    const after = backspace(stateWith(doc, doc.indexOf("b**") + 1));
    expect(after.doc.toString()).toBe("plant  now");
    expect(after.selection.main.head).toBe("plant ".length);
  });

  test("at the start of bold: the letter before it", () => {
    const doc = "plant **basil** now";
    expect(backspace(stateWith(doc, doc.indexOf("basil"))).doc.toString()).toBe("plant**basil** now");
  });

  test("after a link: the last letter of its words, never its address", () => {
    const doc = "near [the door](door.md) end";
    expect(backspace(stateWith(doc, doc.indexOf(" end"))).doc.toString()).toBe("near [the doo](door.md) end");
  });

  test("at the start of a heading's words: the heading becomes a paragraph", () => {
    const doc = "intro\n# Plan\n\nend";
    const after = backspace(stateWith(doc, doc.indexOf("Plan")));
    expect(after.doc.toString()).toBe("intro\nPlan\n\nend");
    expect(after.selection.main.head).toBe(doc.indexOf("#"));
  });

  test("Delete before bold: its first letter", () => {
    const doc = "plant **basil** now";
    expect(forwardDelete(stateWith(doc, doc.indexOf("**"))).doc.toString()).toBe("plant **asil** now");
  });

  test("with Show Markdown on, Backspace deletes what it always did", () => {
    const doc = "plant **basil** now";
    expect(backspace(stateWith(doc, doc.indexOf(" now"), true)).doc.toString()).toBe("plant **basil* now");
  });

  test("ordinary text is left alone", () => {
    const doc = "plant basil now";
    expect(backspace(stateWith(doc, 5)).doc.toString()).toBe("plan basil now");
  });
});
