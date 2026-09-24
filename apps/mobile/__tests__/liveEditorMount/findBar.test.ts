/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { EditorView } from "@codemirror/view";
import { mount, viewIn } from "./fixtures";

/**
 * THE FIND BAR, AND THE TWO THINGS ONLY THIS HALF CAN DO ABOUT IT.
 *
 * `findInNote.test.ts` owns the bar itself — what it draws, what it counts,
 * and that ⌘F and Escape reach it from inside the editor. What it cannot own
 * is the pair of facts that need a *mounted* editor with a host around it:
 *
 *  - The console has to be able to close the bar from a press that never
 *    reached this editor's DOM — Escape at a tree row, a tab, the accessory
 *    bar. That goes through `EditorControls.closeFind`, which is this file's
 *    to hand out, and on to the frame's overlay stack in `NoteEditor`.
 *  - The bar belongs to the document it was searching. This editor is built
 *    once and has notes swapped through it, so nothing about opening another
 *    note would take a stale query bar down on its own.
 */
describe("the find bar and the note it belongs to", () => {
  /** ⌘F, as CodeMirror receives it. */
  function openFind(view: EditorView): void {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
    );
  }

  test("the handle closes it, and says whether there was anything to close", () => {
    const m = mount({ value: "bucket, and bucket again", editable: true, notePath: "a.md" });
    const view = viewIn(m.container);

    expect(m.controls()?.closeFind?.()).toBe(false);

    openFind(view);
    expect(m.container.querySelector(".cm-ctx-find")).not.toBeNull();

    expect(m.controls()?.closeFind?.()).toBe(true);
    expect(m.container.querySelector(".cm-ctx-find")).toBeNull();

    m.unmount();
  });

  test("opening another note takes the bar with it", () => {
    const m = mount({ value: "bucket", editable: true, notePath: "a.md" });
    openFind(viewIn(m.container));
    expect(m.container.querySelector(".cm-ctx-find")).not.toBeNull();

    m.update({ value: "something else entirely", notePath: "b.md" });

    expect(m.container.querySelector(".cm-ctx-find")).toBeNull();
    m.unmount();
  });

  /**
   * And the same note is the same note. Typing arrives here as a `value` change
   * on every keystroke — closing the bar on one would make the search unusable
   * on the surface it exists for.
   */
  test("editing the note does not", () => {
    const m = mount({ value: "bucket", editable: true, notePath: "a.md" });
    openFind(viewIn(m.container));

    m.update({ value: "bucket, twice" });

    expect(m.container.querySelector(".cm-ctx-find")).not.toBeNull();
    m.unmount();
  });
});
