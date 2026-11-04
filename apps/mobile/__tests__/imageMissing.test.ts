/**
 * @jest-environment jsdom
 *
 * AN IMAGE WITH NO PICTURE, IN A REAL VIEW (Dev, 2026-11-03).
 *
 * It was the browser's broken-image glyph over a mono line of storage words,
 * "Not in this bucket: files/…" or "Could not load files/…", with nothing to
 * do about either. It is now an image-sized card: what happened, the file's
 * name, and Replace for a writer when nothing is there, or Try again for
 * anyone when the read failed.
 */

import { describe, expect, test } from "@jest/globals";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorExtensions } from "../features/console/files/editorSetup";

const DOC = "words\n\n![[files/ridge-loop-map.png]]\n\nmore words\n";

function mount(load: () => Promise<string | null>, editable = true): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: DOC,
      extensions: editorExtensions({
        editable,
        editableCompartment: new Compartment(),
        handlers: { current: { onChange: () => {}, onSave: () => {} } },
        images: { current: { load, upload: async () => ({ error: "nothing to upload here" }) } },
      }),
    }),
  });
}

async function settle(): Promise<void> {
  for (let n = 0; n < 6; n += 1) await Promise.resolve();
}

const card = (view: EditorView) => view.dom.querySelector<HTMLElement>(".cm-lp-image-gone");

describe("an image with no picture", () => {
  test("not found: the card, the name, Replace for a writer, and no broken image", async () => {
    const view = mount(async () => null);
    await settle();
    const gone = card(view)!;
    expect(gone.getAttribute("role")).toBe("img");
    expect(gone.getAttribute("aria-label")).toBe("Image not found: ridge-loop-map.png");
    expect(gone.querySelector(".cm-lp-image-gone-title")!.textContent).toBe("Image not found");
    expect(gone.querySelector(".cm-lp-image-gone-name")!.textContent).toBe("ridge-loop-map.png");
    expect(gone.querySelector("button")!.textContent).toBe("Replace");
    // The <img> with no bytes is hidden by its figure's class, and the storage words are gone.
    expect(view.dom.querySelector(".cm-lp-image")!.classList.contains("cm-lp-image-unloaded")).toBe(true);
    expect(view.dom.textContent).not.toMatch(/bucket|Could not load/);
    view.destroy();
  });

  test("a reader gets the card with nothing to press", async () => {
    const view = mount(async () => null, false);
    await settle();
    expect(card(view)).not.toBeNull();
    expect(card(view)!.querySelector("button")).toBeNull();
    view.destroy();
  });

  test("a failed read says so, and Try again loads it in place", async () => {
    let fail = true;
    const view = mount(async () => {
      if (fail) throw new Error("offline");
      return "data:image/png;base64,iVBORw0KGgo=";
    });
    await settle();
    const button = card(view)!.querySelector("button")!;
    expect(card(view)!.querySelector(".cm-lp-image-gone-title")!.textContent).toBe("Couldn't load this image");
    expect(button.textContent).toBe("Try again");

    fail = false;
    button.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    expect(button.textContent).toBe("Loading");
    await settle();
    expect(card(view)).toBeNull();
    const figure = view.dom.querySelector(".cm-lp-image")!;
    expect(figure.classList.contains("cm-lp-image-unloaded")).toBe(false);
    expect(figure.querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    view.destroy();
  });
});
