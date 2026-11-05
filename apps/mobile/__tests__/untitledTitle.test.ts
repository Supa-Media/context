/**
 * @jest-environment jsdom
 */
import { describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { lineStateOf, decodeLineState } from "../features/console/files/lineState";
import { emptyTitle, showTitleHint, untitledTitle } from "../features/console/files/untitledTitle";

/**
 * Board 3 of `meeting-2026-10-17/phone-inbox/`: a new note draws a grey
 * "Title" in its empty title, with "Your agent will file it" under it in the
 * Inbox, and the Aa panel lights what the caret's line is.
 *
 * Since 2026-11-05 a new note's text is `# ` and an empty line: its made-up
 * name is never in the text, so typing into the title is ordinary typing and
 * nothing guesses which part of a change was typed (`untitledTitle.ts`).
 *
 * SABOTAGE: drawing "Title" for any heading fails "a named note draws its own
 * title"; dropping the empty-body check fails "the line under the title goes
 * once there is writing"; dropping the transaction filter fails "backspace
 * does nothing, as in an empty field".
 */

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({ state: EditorState.create({ doc, extensions: [untitledTitle()] }), parent });
}

describe("a new note's title line", () => {
  test("the empty title is drawn as Title", () => {
    const view = mount("# \n\n");
    expect(emptyTitle(view.state)).not.toBeNull();
    expect(view.contentDOM.querySelector(".cm-untitled-title")?.textContent).toBe("Title");
    // The file is untouched: drawing, not editing.
    expect(view.state.doc.toString()).toBe("# \n\n");
  });

  test("behind frontmatter too", () => {
    expect(emptyTitle(mount("---\na: b\n---\n# \n").state)).not.toBeNull();
  });

  test("a named note draws its own title, an old untitled name included", () => {
    for (const doc of ["# untitled ideas for the garden\n", "# untitled-2026-10-17\n\n"]) {
      const view = mount(doc);
      expect(emptyTitle(view.state)).toBeNull();
      expect(view.contentDOM.querySelector(".cm-untitled-title")).toBeNull();
    }
  });

  test("typing into the title shows the words typed", () => {
    const view = mount("# \n");
    view.dispatch({ changes: { from: 2, insert: "Garden" } });
    expect(view.contentDOM.querySelector(".cm-untitled-title")).toBeNull();
    expect(view.contentDOM.textContent).toContain("Garden");
  });

  test("the line under the title comes from the host, and goes once there is writing", () => {
    const view = mount("# \n\n");
    expect(view.dom.querySelector(".cm-untitled-hint")).toBeNull();
    showTitleHint(view, "Your agent will file it");
    expect(view.dom.querySelector(".cm-untitled-hint")?.textContent).toBe("Your agent will file it");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "Tomatoes" } });
    expect(view.dom.querySelector(".cm-untitled-hint")).toBeNull();
    showTitleHint(view, null);
    view.dispatch({ changes: { from: view.state.doc.length - 8, to: view.state.doc.length, insert: "" } });
    expect(view.dom.querySelector(".cm-untitled-hint")).toBeNull();
  });
});

/** What a keystroke at `at` (or over `from`..`to`) does, as the person's own input. */
function type(view: EditorView, text: string, from: number, to = from): void {
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.type" });
}

describe("typing into an empty title", () => {
  test("what is typed is the title", () => {
    const view = mount("# \n\nbody");
    type(view, "I", 2);
    type(view, "s", view.state.selection.main.head);
    expect(view.state.doc.toString()).toBe("# Is\n\nbody");
    expect(view.state.selection.main.head).toBe(4);
  });

  test("backspace does nothing, as in an empty field", () => {
    const view = mount("# \n");
    view.dispatch({ changes: { from: 1, to: 2 }, userEvent: "delete.backward" });
    expect(view.state.doc.toString()).toBe("# \n");
    expect(view.contentDOM.querySelector(".cm-untitled-title")?.textContent).toBe("Title");
  });

  test("Enter in the title starts the body", () => {
    const view = mount("# ");
    type(view, "\n", 2);
    expect(view.state.doc.toString()).toBe("# \n");
  });

  test("a named title, a collaborator's change and an edit below are left alone", () => {
    const named = mount("# Garden\n");
    type(named, "s", 8);
    expect(named.state.doc.toString()).toBe("# Gardens\n");
    const remote = mount("# \n");
    remote.dispatch({ changes: { from: 2, insert: "x" } });
    expect(remote.state.doc.toString()).toBe("# x\n");
    const below = mount("# \n\n");
    type(below, "Tomatoes", 4);
    expect(below.state.doc.toString()).toBe("# \n\nTomatoes");
  });
});

describe("what the Aa panel lights", () => {
  test.each([
    ["# Weekly", { style: "title", list: null }],
    ["## Notes", { style: "heading", list: null }],
    ["### Deeper", { style: "heading", list: null }],
    ["Plain words", { style: "body", list: null }],
    ["- milk", { style: "body", list: "bullet" }],
    ["  * eggs", { style: "body", list: "bullet" }],
    ["- [ ] call Sam", { style: "body", list: "task" }],
    ["- [x] done", { style: "body", list: "task" }],
    ["1. first", { style: "body", list: "number" }],
    ["#hashtag", { style: "body", list: null }],
  ])("%s", (text, expected) => {
    expect(lineStateOf(text)).toEqual(expected);
  });

  test("only those shapes cross the bridge", () => {
    expect(decodeLineState({ style: "title", list: "task" })).toEqual({ style: "title", list: "task" });
    expect(decodeLineState({ style: "huge", list: null })).toBeNull();
    expect(decodeLineState({ style: "body", list: "<b>" })).toBeNull();
    expect(decodeLineState(null)).toBeNull();
  });
});
