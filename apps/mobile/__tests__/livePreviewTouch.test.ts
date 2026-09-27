/**
 * @jest-environment jsdom
 *
 * TAPS, IN A REAL VIEW: THE HEADING THAT KEEPS ITS `#`, AND THE DEMO SCRIPT
 * THAT OPENS.
 *
 * Both are about which input placed the caret, and that fact only exists in a
 * mounted view — a `pointerdown` carries it, and `livePreview()` turns it into
 * state (`caretInput`). So these assertions are made against the DOM the
 * editor draws, with the full `editorExtensions` the web console and the iOS
 * WebView guest both install.
 */

import { describe, expect, test } from "@jest/globals";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorExtensions } from "../features/console/files/editorSetup";
import { caretInput } from "../features/console/files/livePreview/engagement";

function mount(doc: string, options: { editable?: boolean } = {}): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: editorExtensions({
        editable: options.editable ?? true,
        editableCompartment: new Compartment(),
        handlers: { current: { onChange: () => {}, onSave: () => {} } },
      }),
    }),
  });
}

/** jsdom has no `PointerEvent`; a `MouseEvent` of that name with the field set is what it can do. */
function pointerDown(view: EditorView, pointerType: "touch" | "mouse" | "pen"): void {
  const event = new window.MouseEvent("pointerdown", { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  view.contentDOM.dispatchEvent(event);
}

/** What a tap or a click leaves behind: a pointer selection at `at`. */
function tap(view: EditorView, pointerType: "touch" | "mouse" | "pen", at: number): void {
  pointerDown(view, pointerType);
  view.dispatch({ selection: { anchor: at }, userEvent: "select.pointer" });
}

const lineText = (view: EditorView, index: number): string =>
  (view.contentDOM.querySelectorAll(".cm-line")[index] as HTMLElement).textContent ?? "";

describe("a tapped heading keeps its marks hidden", () => {
  const DOC = "# Title\n\nbody text\n\n## Second\n\nmore";

  test("a finger in the heading's words leaves `#` off the screen", () => {
    const view = mount(DOC);
    tap(view, "touch", DOC.indexOf("Title") + 2);
    expect(view.state.field(caretInput)).toBe("touch");
    expect(lineText(view, 0)).toBe("Title");
  });

  test("so does a tap at either edge of the hidden marks", () => {
    const view = mount(DOC);
    tap(view, "touch", 0);
    expect(lineText(view, 0)).toBe("Title");
    tap(view, "touch", 2);
    expect(lineText(view, 0)).toBe("Title");
  });

  test("a pen is a finger", () => {
    const view = mount(DOC);
    tap(view, "pen", 4);
    expect(lineText(view, 0)).toBe("Title");
  });

  test("a mouse click reveals, as it always did", () => {
    const view = mount(DOC);
    tap(view, "mouse", 4);
    expect(view.state.field(caretInput)).toBe("precise");
    expect(lineText(view, 0)).toBe("# Title");
  });

  test("an arrow key after a tap reveals: that is somebody with a keyboard", () => {
    const view = mount(DOC);
    tap(view, "touch", 4);
    view.dispatch({ selection: { anchor: 5 }, userEvent: "select" });
    expect(lineText(view, 0)).toBe("# Title");
  });

  test("a selection that reaches the marks reveals them", () => {
    const view = mount(DOC);
    tap(view, "touch", 4);
    view.dispatch({ selection: { anchor: 0, head: 7 }, userEvent: "select.pointer" });
    expect(lineText(view, 0)).toBe("# Title");
  });

  test("a selection of the words alone does not", () => {
    const view = mount(DOC);
    tap(view, "touch", 4);
    view.dispatch({ selection: { anchor: 2, head: 7 }, userEvent: "select.pointer" });
    expect(lineText(view, 0)).toBe("Title");
  });

  test("typing a `#` at the start of the line reveals while you change the level", () => {
    const view = mount(DOC);
    tap(view, "touch", 0);
    view.dispatch({ changes: { from: 0, insert: "#" }, selection: { anchor: 1 }, userEvent: "input.type" });
    expect(lineText(view, 0)).toBe("## Title");
  });

  test("typing in the heading's words keeps them clean", () => {
    const view = mount(DOC);
    tap(view, "touch", 7);
    view.dispatch({ changes: { from: 7, insert: "s" }, selection: { anchor: 8 }, userEvent: "input.type" });
    expect(lineText(view, 0)).toBe("Titles");
  });

  test("other marks still reveal on a tap: the rule is about headings", () => {
    const doc = "some **bold** words";
    const view = mount(doc);
    tap(view, "touch", doc.indexOf("bold") + 1);
    expect(lineText(view, 0)).toBe("some **bold** words");
  });
});
