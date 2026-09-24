/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act } from "react";
import { mount, viewIn } from "./fixtures";

/**
 * THE ACCESSORY BAR'S SEAM, ON THE HALF THAT HOLDS A REAL `EditorView`.
 *
 * `webviewBridge.test.ts` proves the same five verbs over the JSON bridge. This
 * proves them here — where there is no bridge and the handle points straight at
 * CodeMirror — because the two halves run the *same* `runCommand` and the thing
 * that would break silently is one of them not being wired to it.
 *
 * The bar itself never renders on this surface: it is compact-only, and a
 * pointer has a keyboard and the chords that come with it. What is tested here
 * is the contract underneath it.
 */
describe("the imperative handle", () => {
  test("arrives once, on mount, and is not re-handed on every render", () => {
    const m = mount({ value: "hello", editable: true });
    expect(m.handles).toHaveLength(1);
    expect(m.handles[0]).not.toBeNull();

    m.update({ value: "hello there" });
    m.update({ value: "hello there!" });
    expect(m.handles).toHaveLength(1);
    m.unmount();
  });

  /**
   * The `null` is not politeness. The bar outlives a note change on a phone,
   * and a handle held past unmount points at a destroyed `EditorView`, where
   * CodeMirror's `dispatch` throws rather than no-ops.
   */
  test("and is handed back as null before the view is destroyed", () => {
    const m = mount({ value: "hello", editable: true });
    m.unmount();
    expect(m.handles).toEqual([expect.anything(), null]);
  });

  test("wrap puts the markers round the selection and leaves it selected", () => {
    const m = mount({ value: "one two three", editable: true });
    const view = viewIn(m.container);
    act(() => view.dispatch({ selection: { anchor: 4, head: 7 } }));

    act(() => m.controls()?.wrap("**", "**"));

    expect(view.state.doc.toString()).toBe("one **two** three");
    expect(m.changes[m.changes.length - 1]).toBe("one **two** three");
    expect(view.state.selection.main.from).toBe(6);
    expect(view.state.selection.main.to).toBe(9);
    m.unmount();
  });

  test("toggleLinePrefix goes on and comes off the caret's line", () => {
    const m = mount({ value: "first\nsecond", editable: true });
    const view = viewIn(m.container);
    act(() => view.dispatch({ selection: { anchor: 8 } }));

    act(() => m.controls()?.toggleLinePrefix("# "));
    expect(view.state.doc.toString()).toBe("first\n# second");

    act(() => m.controls()?.toggleLinePrefix("# "));
    expect(view.state.doc.toString()).toBe("first\nsecond");
    m.unmount();
  });

  /**
   * One history, not two.
   *
   * This is the platform with a hardware keyboard, so `undo()` and ⌘Z have to
   * step through the same past. A value stack kept beside the editor would be a
   * second history that disagrees with the one the keymap drives.
   */
  test("undo and redo are the same history the keymap drives", () => {
    const m = mount({ value: "one", editable: true });
    const view = viewIn(m.container);
    act(() => view.dispatch({ changes: { from: 3, insert: " two" } }));
    expect(view.state.doc.toString()).toBe("one two");

    act(() => m.controls()?.undo());
    expect(view.state.doc.toString()).toBe("one");

    act(() => m.controls()?.redo());
    expect(view.state.doc.toString()).toBe("one two");
    m.unmount();
  });

  /**
   * The same bug the iOS half had, and it was here too: an authoritative
   * document replacement — a different note, a discarded draft, a resolved
   * conflict — used to land in the undo history, so one press of undo after
   * switching notes pulled the previous note back. See `replaceDocument`.
   */
  test("undo does not reach back into the note that was open before this one", () => {
    const m = mount({ value: "first note", editable: true });
    const view = viewIn(m.container);
    m.update({ value: "second note entirely" });

    act(() => m.controls()?.undo());
    act(() => m.controls()?.undo());
    expect(view.state.doc.toString()).toBe("second note entirely");
    m.unmount();
  });

  test("blur lets go of the editing surface", () => {
    const m = mount({ value: "hello", editable: true });
    const view = viewIn(m.container);
    act(() => view.focus());
    expect(m.focus[m.focus.length - 1]).toBe(true);

    act(() => m.controls()?.blur());
    expect(m.focus[m.focus.length - 1]).toBe(false);
    m.unmount();
  });

  /**
   * EVERY KEY ON THE BAR IS A PROGRAMMATIC EDIT.
   *
   * Which is what `EditorView.editable.of(false)` does not stop. The bar is not
   * rendered over a note the viewer may not write — `accessoryUp` takes
   * `editable` — and this is the refusal that does not depend on that staying
   * true, on the surface where the handle is a direct pointer at the view.
   */
  test("and none of them can change a note the viewer may not write", () => {
    const m = mount({ value: "# secret\n\nbody", editable: false });
    const view = viewIn(m.container);
    act(() => view.dispatch({ selection: { anchor: 10, head: 14 } }));

    act(() => {
      const api = m.controls();
      api?.wrap("**", "**");
      api?.toggleLinePrefix("# ");
      api?.undo();
      api?.redo();
    });

    expect(view.state.doc.toString()).toBe("# secret\n\nbody");
    expect(m.changes).toEqual([]);
    m.unmount();
  });

  /** The dismiss key is the one that must never be refused. */
  test("except blur, which writes nothing", () => {
    const m = mount({ value: "# secret\n\nbody", editable: false });
    const view = viewIn(m.container);
    act(() => view.focus());
    act(() => m.controls()?.blur());
    expect(m.focus).toEqual([true, false]);
    m.unmount();
  });
});
