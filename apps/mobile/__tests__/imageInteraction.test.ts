/**
 * @jest-environment jsdom
 *
 * CLICKING AN IMAGE, IN A REAL VIEW.
 *
 * This file exists because of a bug no unit test could have caught: the click
 * *did* set the selection — the effect landed in the field and the field held
 * it — and nothing was drawn, because `livePreview`'s decoration field only
 * recomputes when the document, the selection, `readOnly`, the tree or the
 * focus changed, and an image being picked is none of those. Every assertion
 * here is therefore made against a mounted `EditorView` and its DOM, which is
 * the only place the two halves meet.
 *
 * The interaction being pinned is the one a pointer expects:
 *
 *   press and release without moving  → the image is selected, and its toolbar
 *                                       and corner handles are on screen
 *   press and drag past a few pixels  → the image moves, and is deselected
 *   a press anywhere else             → nothing is selected any more
 *
 * plus the affordance that needs no click at all: the side handles are in the
 * DOM of every writable image, so hovering can reveal them and a resize is one
 * drag rather than a click and a drag.
 */

import { describe, expect, test } from "@jest/globals";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorExtensions } from "../features/console/files/editorSetup";
import { imageSelection } from "../features/console/files/imageBlock";

const DOC = "words\n\n![[paste-abc.png]]\n\nmore words\n";

function mount(options: { editable?: boolean } = {}): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: DOC,
      extensions: editorExtensions({
        editable: options.editable ?? true,
        editableCompartment: new Compartment(),
        handlers: { current: { onChange: () => {}, onSave: () => {} } },
        images: {
          current: {
            load: async () => "data:image/png;base64,iVBORw0KGgo=",
            upload: async () => ({ error: "nothing to upload here" }),
          },
        },
      }),
    }),
  });
}

/** jsdom has no `PointerEvent`; a `MouseEvent` of the same name is what it has. */
function press(target: Element, type: string, at: { x: number; y: number }): void {
  target.dispatchEvent(
    new window.MouseEvent(type, { bubbles: true, clientX: at.x, clientY: at.y }),
  );
}

function pressWindow(type: string, at: { x: number; y: number }): void {
  window.dispatchEvent(
    new window.MouseEvent(type, { bubbles: true, clientX: at.x, clientY: at.y }),
  );
}

describe("a press on an image", () => {
  test("selects it, and the toolbar is drawn", () => {
    const view = mount();
    const figure = view.dom.querySelector(".cm-lp-image")!;
    expect(view.dom.querySelector(".cm-lp-image-bar")).toBeNull();

    press(figure, "pointerdown", { x: 40, y: 40 });
    pressWindow("pointerup", { x: 40, y: 40 });

    expect(view.state.field(imageSelection)).toEqual({ from: 7, index: 0 });
    // The half that was missing: the field held the pick and the view drew the
    // old decorations, so nothing appeared.
    expect(view.dom.querySelector(".cm-lp-image-bar")).not.toBeNull();
    expect(view.dom.querySelector(".cm-lp-image-on")).not.toBeNull();
    expect(view.dom.querySelectorAll(".cm-lp-image-handle").length).toBe(6);
    view.destroy();
  });

  test("a press that travels moves the image instead of selecting it", () => {
    const view = mount();
    const figure = view.dom.querySelector(".cm-lp-image")!;
    press(figure, "pointerdown", { x: 40, y: 40 });
    pressWindow("pointermove", { x: 40, y: 400 });
    pressWindow("pointerup", { x: 40, y: 400 });

    // jsdom has no layout, so `posAtCoords` answers null and the drop is
    // cancelled — what is asserted is the half this test can see: a drag is not
    // a click, so nothing is selected and the note is unchanged.
    expect(view.state.field(imageSelection)).toBeNull();
    expect(view.dom.querySelector(".cm-lp-image-bar")).toBeNull();
    view.destroy();
  });

  test("putting the caret anywhere else puts the image down", () => {
    const view = mount();
    const figure = view.dom.querySelector(".cm-lp-image")!;
    press(figure, "pointerdown", { x: 40, y: 40 });
    pressWindow("pointerup", { x: 40, y: 40 });
    expect(view.dom.querySelector(".cm-lp-image-bar")).not.toBeNull();

    // Clicking into the text, arrowing away and typing all come through here:
    // one definition of "the cursor is elsewhere", which this editor already has.
    view.dispatch({ selection: { anchor: 2 } });

    expect(view.state.field(imageSelection)).toBeNull();
    expect(view.dom.querySelector(".cm-lp-image-bar")).toBeNull();
    view.destroy();
  });

  test("its own toolbar does not put it down", () => {
    const view = mount();
    const figure = view.dom.querySelector(".cm-lp-image")!;
    press(figure, "pointerdown", { x: 40, y: 40 });
    pressWindow("pointerup", { x: 40, y: 40 });

    // A width chip writes one line and carries no selection of its own, so the
    // image stays picked and the bar stays under the hand that pressed it.
    const chip = view.dom.querySelectorAll(".cm-lp-image-chip")[1] as HTMLElement;
    press(chip, "pointerdown", { x: 40, y: 10 });

    expect(view.state.doc.toString()).toContain("![[paste-abc.png|");
    expect(view.state.field(imageSelection)).not.toBeNull();
    expect(view.dom.querySelector(".cm-lp-image-bar")).not.toBeNull();
    view.destroy();
  });

  test("the side handles are there before any click, so a resize is one drag", () => {
    const view = mount();
    const handles = view.dom.querySelectorAll(".cm-lp-image-handle");
    expect(handles.length).toBe(2);
    expect(view.dom.querySelector(".cm-lp-image-handle-w")).not.toBeNull();
    expect(view.dom.querySelector(".cm-lp-image-handle-e")).not.toBeNull();
    view.destroy();
  });

  test("a reader gets a picture and no handles at all", () => {
    const view = mount({ editable: false });
    expect(view.dom.querySelector(".cm-lp-image")).not.toBeNull();
    expect(view.dom.querySelectorAll(".cm-lp-image-handle").length).toBe(0);
    expect(view.dom.querySelector(".cm-lp-image-live")).toBeNull();

    press(view.dom.querySelector(".cm-lp-image")!, "pointerdown", { x: 40, y: 40 });
    pressWindow("pointerup", { x: 40, y: 40 });
    expect(view.state.field(imageSelection)).toBeNull();
    view.destroy();
  });

  test("the markup never comes back, whatever is selected", () => {
    const view = mount();
    const figure = view.dom.querySelector(".cm-lp-image")!;
    press(figure, "pointerdown", { x: 40, y: 40 });
    pressWindow("pointerup", { x: 40, y: 40 });
    expect(view.dom.textContent).not.toContain("paste-abc.png]]");
    view.destroy();
  });
});
