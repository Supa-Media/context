/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { EditorView } from "@codemirror/view";
import { insertNewline } from "@codemirror/commands";
import { mount, viewIn, renderedText } from "./fixtures";

describe("React must not fight the editor", () => {
  /**
   * THE test this file exists for.
   *
   * The parent re-renders with the *same* text — which is what happens on every
   * keystroke once `onChange` has run — and the editor must not be written to.
   * If it is, the selection resets and the caret jumps to the end of the
   * document.
   */
  test("the parent echoing back what was just typed leaves the caret alone", () => {
    const m = mount({ value: "hello world", editable: true });
    const view = viewIn(m.container);

    // Type an X at position 5, the way a person would. The caret lands after
    // it, in the middle of the document.
    view.dispatch({
      changes: { from: 5, insert: "X" },
      selection: { anchor: 6 },
    });
    expect(view.state.doc.toString()).toBe("helloX world");
    expect(view.state.selection.main.head).toBe(6);

    // The reducer now re-renders with that same text. This is the echo, and it
    // is a *changed* prop — which is why an earlier version of this test, which
    // re-rendered with unchanged text, proved nothing: React skips the effect
    // entirely when the dependency is referentially equal, so the guard was
    // never reached and removing it did not fail anything.
    m.update({ value: "helloX world" });

    // Without the `value === latestValue.current` guard the effect replaces the
    // whole document here, and the caret is thrown to the end.
    expect(view.state.doc.toString()).toBe("helloX world");
    expect(view.state.selection.main.head).toBe(6);
    m.unmount();
  });

  /**
   * The other direction: text that genuinely came from outside — a different
   * note opened, a draft discarded, a conflict resolved with "load theirs" —
   * must land in the editor. Suppressing this to avoid the loop above would
   * mean opening a second note and seeing the first one's contents.
   */
  test("authoritative text from outside is written in", () => {
    const m = mount({ value: "first note", editable: true });
    m.update({ value: "second note entirely" });
    expect(renderedText(m.container)).toContain("second note entirely");
    m.unmount();
  });

  test("typing reaches onChange exactly once per change", () => {
    const m = mount({ value: "", editable: true });
    viewIn(m.container).dispatch({ changes: { from: 0, insert: "typed" } });

    expect(m.changes).toEqual(["typed"]);
    m.unmount();
  });
});

describe("editability", () => {
  test("a read-only note is not editable, and stays wired up", () => {
    const m = mount({ value: "text", editable: true });
    m.update({ editable: false });

    const view = viewIn(m.container);
    expect(view.state.facet(EditorView.editable)).toBe(false);

    /**
     * The important half of this test is the second assertion. Toggling
     * editability by replacing the whole configuration — which an earlier draft
     * did — silently rebuilds the update listener and detaches typing from
     * `onChange`. A compartment swaps one facet and leaves the listener alone,
     * so a change still reports after the swap.
     *
     * It used to make that change while read-only, which read as the tidier
     * test and stopped being possible when `editability` grew a `changeFilter`:
     * a read-only note now refuses the change itself, so an `onChange` after it
     * would mean the gate had failed rather than that the listener had
     * survived. Toggling back exercises the compartment twice instead, which is
     * the same claim proved harder.
     */
    m.update({ editable: true });
    view.dispatch({ changes: { from: 0, insert: "more " } });
    expect(m.changes).toEqual(["more text"]);
    m.unmount();
  });

  /**
   * The other half of the `changeFilter`, on the surface it was written for.
   *
   * `EditorState.readOnly` is what `@codemirror/view`'s drop, paste and cut
   * handlers consult, and it is what `deleteCharBackward` consults — but it is
   * a convention rather than a gate, and `@codemirror/commands` breaks it
   * itself: `insertNewline` replaces the selection and returns `true` without
   * looking. The filter is what makes "read-only" mean the document.
   */
  test("and nothing at all can change a read-only document", () => {
    const m = mount({ value: "text", editable: false });
    const view = viewIn(m.container);

    insertNewline(view);
    view.dispatch({ changes: { from: 0, insert: "INJECTED" } });

    expect(view.state.doc.toString()).toBe("text");
    expect(m.changes).toEqual([]);
    m.unmount();
  });
});
