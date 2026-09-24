/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { reportSelection } from "../../features/console/presence/remoteCarets";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

describe("presence cannot break the editor", () => {
  /**
   * The defect this describes was shipped and reported: somebody typed and
   * their characters did not appear.
   *
   * An `updateListener` runs *inside* the transaction applying a keystroke, so
   * a reporter that throws takes the edit with it — and it is reported as "the
   * editor is broken", not as "presence is broken", because from the typist's
   * side that is what happened. The guard is the try/catch in
   * `reportSelection`; this is what makes it a guard rather than a comment.
   */
  function editorWith(report: (anchor: number, head: number) => void) {
    const view = new EditorView({
      state: EditorState.create({
        doc: "hello",
        extensions: [reportSelection(() => report)],
      }),
    });
    return view;
  }

  test("a reporter that throws does not stop the document changing", () => {
    const view = editorWith(() => {
      throw new Error("socket in a state nobody predicted");
    });
    expect(() =>
      view.dispatch({ changes: { from: 5, insert: " world" } }),
    ).not.toThrow();
    expect(view.state.doc.toString()).toBe("hello world");
    view.destroy();
  });

  test("a reporter that throws does not stop the selection moving", () => {
    const view = editorWith(() => {
      throw new Error("nope");
    });
    view.dispatch({ selection: { anchor: 2 } });
    expect(view.state.selection.main.anchor).toBe(2);
    view.destroy();
  });

  test("a working reporter is told where the caret went", () => {
    // Non-vacuity: without this, both checks above pass against a listener that
    // was never wired up at all.
    const seen: number[][] = [];
    const view = editorWith((anchor, head) => seen.push([anchor, head]));
    view.dispatch({ changes: { from: 5, insert: "!" }, selection: { anchor: 6 } });
    expect(seen.at(-1)).toEqual([6, 6]);
    view.destroy();
  });
});
