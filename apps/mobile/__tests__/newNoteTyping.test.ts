/**
 * @jest-environment jsdom
 */
import { describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { titleLock } from "../features/console/files/titleLock";
import { untitledTitle } from "../features/console/files/untitledTitle";

/**
 * A quick note, typed into, with both filters a real editor installs:
 * `untitledTitle` (the placeholder) and `titleLock` (the title's rules).
 * Reported 2026-10-19 and again 2026-11-05: typing into the grey Title
 * appended to a name nobody could see. A new note's title is empty now
 * (`seedFor`), so there is no name to append to.
 *
 * SABOTAGE: putting back "typed into an empty note is the title" fails the
 * last case; writing the untitled name into a heading-less note fails it too.
 */

const PATH = "0-inbox/untitled-2026-10-19.md";

function mount(doc: string, caret: number): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [untitledTitle(), titleLock(() => PATH)],
  });
  return new EditorView({ state, parent });
}

function type(view: EditorView, text: string): void {
  for (const character of text) {
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: character }, selection: { anchor: at + 1 }, userEvent: "input.type" });
  }
}

describe("typing into a new note", () => {
  test("after the grey Title, the title is what was typed", () => {
    const view = mount("# \n\n", 2);
    type(view, "Is");
    expect(view.state.doc.toString()).toBe("# Is\n\n");
  });

  test("in the body, the title stays as it was", () => {
    const view = mount("# \n\n", 4);
    type(view, "milk");
    expect(view.state.doc.toString()).toBe("# \n\nmilk");
  });

  test("backspace on the grey Title leaves it", () => {
    const view = mount("# \n\n", 2);
    view.dispatch({ changes: { from: 1, to: 2 }, userEvent: "delete.backward" });
    expect(view.state.doc.toString()).toBe("# \n\n");
  });

  test("into an empty note, what is typed is the body", () => {
    const view = mount("", 0);
    type(view, "sdasd");
    expect(view.state.doc.toString()).toBe("# \n\nsdasd");
  });

  test("deleting a typed title leaves the empty title, not the made-up name", () => {
    const view = mount("# \n\nbody", 2);
    type(view, "Hi");
    view.dispatch({ changes: { from: 2, to: 4 }, userEvent: "delete.backward" });
    expect(view.state.doc.toString()).toBe("# \n\nbody");
  });
});
