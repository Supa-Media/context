/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  propertySlot,
  propertySlotAt,
  showPropertySlot,
} from "../features/console/files/liveEditorWeb/propertySlot";

/**
 * The box under a note's title that the property chips are portalled into
 * (`liveEditorWeb/propertySlot.ts`).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits, and reverted.
 *
 * 1. **`destroy` removing the host unconditionally** — "the host moves with
 *    the box when the title stops being one" fails: the old box, destroyed
 *    after the new one was drawn, took the host out of it.
 * 2. **`propertySlotAt` ignoring the front matter** — "after the front matter
 *    in a note with no title" fails: the box landed inside the folded block.
 */

const views: EditorView[] = [];
afterEach(() => {
  while (views.length > 0) views.pop()!.destroy();
  document.body.innerHTML = "";
});

const at = (doc: string) => propertySlotAt(EditorState.create({ doc }));

describe("where the box goes", () => {
  test("after the title line", () => {
    expect(at("# Cafe\n\nWords.")).toEqual({ pos: "# Cafe".length, side: 1 });
  });

  test("after the title, past the front matter", () => {
    const doc = "---\nstatus: to do\n---\n\n# Cafe\n\nWords.";
    expect(at(doc)).toEqual({ pos: doc.indexOf("# Cafe") + "# Cafe".length, side: 1 });
  });

  test("before the first line of the body in a note with no title", () => {
    expect(at("Words.")).toEqual({ pos: 0, side: -1 });
  });

  test("after the front matter in a note with no title", () => {
    const doc = "---\nstatus: to do\n---\nWords.";
    expect(at(doc)).toEqual({ pos: doc.indexOf("Words."), side: -1 });
  });

  test("an empty note still has a place", () => {
    expect(at("")).toEqual({ pos: 0, side: -1 });
  });
});

function editor(doc: string) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [propertySlot()] }), parent });
  views.push(view);
  return view;
}

describe("the box", () => {
  test("holds the host, and is not editable", () => {
    const view = editor("# Cafe\n\nWords.");
    const host = document.createElement("div");
    showPropertySlot(view, host);
    const box = view.dom.querySelector<HTMLElement>(".cm-lp-property-slot");
    expect(box).not.toBeNull();
    expect(box!.contains(host)).toBe(true);
    expect(box!.contentEditable).toBe("false");
  });

  test("the chips' host survives the title being retyped", () => {
    const view = editor("# Cafe\n\nWords.");
    const host = document.createElement("div");
    showPropertySlot(view, host);
    for (const letter of " opening") {
      view.dispatch({ changes: { from: view.state.doc.line(1).to, insert: letter } });
    }
    expect(view.state.doc.line(1).text).toBe("# Cafe opening");
    expect(host.isConnected).toBe(true);
    expect(view.dom.querySelectorAll(".cm-lp-property-slot")).toHaveLength(1);
  });

  test("the host moves with the box when the title stops being one", () => {
    const view = editor("# Cafe\n\nWords.");
    const host = document.createElement("div");
    showPropertySlot(view, host);
    view.dispatch({ changes: { from: 0, to: 2 } });
    expect(view.state.doc.line(1).text).toBe("Cafe");
    expect(host.isConnected).toBe(true);
    view.dispatch({ changes: { from: 0, insert: "# " } });
    expect(host.isConnected).toBe(true);
    expect(view.dom.querySelectorAll(".cm-lp-property-slot")).toHaveLength(1);
  });

  test("is taken away with null", () => {
    const view = editor("# Cafe");
    const host = document.createElement("div");
    showPropertySlot(view, host);
    showPropertySlot(view, null);
    expect(view.dom.querySelector(".cm-lp-property-slot")).toBeNull();
    expect(host.isConnected).toBe(false);
  });
});
