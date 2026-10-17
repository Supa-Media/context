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
 * under the title goes once there is writing".
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
