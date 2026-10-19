/**
 * @jest-environment jsdom
 */
import { describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { lineStateOf, decodeLineState } from "../features/console/files/lineState";
import { placeholderTitle, showTitleHint, untitledTitle } from "../features/console/files/untitledTitle";

/**
 * Board 3 of `meeting-2026-10-17/phone-inbox/`: a new note draws a grey
 * "Title" over its placeholder name, with "Your agent will file it" under it
 * in the Inbox, and the Aa panel lights what the caret's line is.
 *
 * SABOTAGE: widening the placeholder pattern to any heading fails "a named
 * note draws its own title"; dropping the empty-body check fails "the line
 * under the title goes once there is writing"; dropping the transaction
 * filter fails every test under "typing into a placeholder title".
 */

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({ state: EditorState.create({ doc, extensions: [untitledTitle()] }), parent });
}

describe("a new note's title line", () => {
  test("the placeholder name is drawn as Title", () => {
    const view = mount("# untitled-2026-10-17\n\n");
    expect(placeholderTitle(view.state)).not.toBeNull();
    expect(view.contentDOM.querySelector(".cm-untitled-title")?.textContent).toBe("Title");
    expect(view.contentDOM.textContent).not.toContain("untitled-2026-10-17");
    // The file is untouched: drawing, not editing.
    expect(view.state.doc.toString()).toBe("# untitled-2026-10-17\n\n");
  });

  test("so is a second one that day, behind frontmatter", () => {
    expect(placeholderTitle(mount("---\na: b\n---\n# untitled-2026-10-17-2\n").state)).not.toBeNull();
  });

  test("a named note draws its own title", () => {
    const view = mount("# untitled ideas for the garden\n");
    expect(placeholderTitle(view.state)).toBeNull();
    expect(view.contentDOM.querySelector(".cm-untitled-title")).toBeNull();
  });

  test("typing over the placeholder shows the words typed", () => {
    const view = mount("# untitled-2026-10-17\n");
    view.dispatch({ changes: { from: 2, to: 21, insert: "Garden" } });
    expect(view.contentDOM.querySelector(".cm-untitled-title")).toBeNull();
    expect(view.contentDOM.textContent).toContain("Garden");
  });

  test("the line under the title comes from the host, and goes once there is writing", () => {
    const view = mount("# untitled-2026-10-17\n\n");
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

describe("typing into a placeholder title", () => {
  // Reported 2026-10-19: a click on the grey Title put the caret at the end of
  // the hidden name, and typing made `# untitled-2026-10-19Is`.
  test("a keystroke at the end of the hidden name replaces it", () => {
    const view = mount("# untitled-2026-10-19\n\nbody");
    type(view, "I", 21);
    type(view, "s", view.state.selection.main.head);
    expect(view.state.doc.toString()).toBe("# Is\n\nbody");
    expect(view.state.selection.main.head).toBe(4);
  });

  test("so does one anywhere else in the line, the `# ` included", () => {
    const view = mount("---\na: b\n---\n# untitled-2026-10-19-2\n");
    type(view, "G", 14);
    expect(view.state.doc.toString()).toBe("---\na: b\n---\n# G\n");
  });

  test("a paste replaces it too", () => {
    const view = mount("# untitled-2026-10-19\n");
    view.dispatch({ changes: { from: 10, insert: "Weekly sync" }, userEvent: "input.paste" });
    expect(view.state.doc.toString()).toBe("# Weekly sync\n");
  });

  test("backspace does nothing, as in an empty field", () => {
    const view = mount("# untitled-2026-10-19\n");
    view.dispatch({ changes: { from: 20, to: 21 }, userEvent: "delete.backward" });
    expect(view.state.doc.toString()).toBe("# untitled-2026-10-19\n");
    expect(view.contentDOM.querySelector(".cm-untitled-title")?.textContent).toBe("Title");
  });

  test("Enter at the end of the title starts the body and keeps the name", () => {
    const view = mount("# untitled-2026-10-19");
    type(view, "\n", 21);
    expect(view.state.doc.toString()).toBe("# untitled-2026-10-19\n");
  });

  test("a named title, a collaborator's change and an edit below are left alone", () => {
    const named = mount("# Garden\n");
    type(named, "s", 8);
    expect(named.state.doc.toString()).toBe("# Gardens\n");
    const remote = mount("# untitled-2026-10-19\n");
    remote.dispatch({ changes: { from: 21, insert: "x" } });
    expect(remote.state.doc.toString()).toBe("# untitled-2026-10-19x\n");
    const below = mount("# untitled-2026-10-19\n\n");
    type(below, "Tomatoes", 23);
    expect(below.state.doc.toString()).toBe("# untitled-2026-10-19\n\nTomatoes");
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
