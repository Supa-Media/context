/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act } from "react";
import { forceParsing, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { mount, viewIn, gridsIn, renderedText } from "./fixtures";

/**
 * THE EYE REDRAWS THE NOTE, RATHER THAN ARMING THE NEXT CLICK TO REDRAW IT.
 *
 * Reading mode is not a repaint — several decorations are a function of
 * `state.readOnly`, and the two loudest are the ones a reader is there for: a
 * `form` fence becomes a form and a table becomes a grid only when the note
 * cannot be typed into (`formFences`, `tableGrids`, and `revealSelection`
 * behind both).
 *
 * The toggle reaches the editor as a **compartment reconfigure** and nothing
 * else: no document change, no selection change. `livePreview`'s state field
 * used to return its cached set unless one of those two had happened, so
 * pressing the eye left every read-mode decoration computed under the previous
 * value of `readOnly` — and the note stayed as its own source until the next
 * click put a cursor in it, which is exactly how it was reported.
 *
 * Every existing test of this logic builds a **fresh** `EditorState` with
 * `EditorState.readOnly.of(true)`, which runs the field's `create` and can
 * never see it. So this one has to mount and flip the prop, which is the only
 * way the transaction under test gets built at all.
 */
describe("toggling reading mode redraws the note on the spot", () => {
  const FORM = [
    "# Request a feature",
    "",
    "```form",
    "id: feature-requests",
    "responses: feature-requests-responses.md",
    "layout: table",
    "submit: member",
    "edit_own: true",
    "votes: named",
    "fields:",
    "  - { name: title, type: line, max: 120, required: true }",
    "```",
    "",
  ].join("\n");

  test("a form fence becomes a form with no click in between", () => {
    const m = mount({ value: FORM, editable: true });
    expect(m.container.querySelector(".cm-lp-form")).toBeNull();

    // The only thing that happens is the prop changing. No dispatch, no focus,
    // no selection — the same as pressing the eye and touching nothing.
    m.update({ editable: false });
    expect(m.container.querySelector(".cm-lp-form")).not.toBeNull();

    m.unmount();
  });

  test("a table is a grid in both modes, and the press takes the editing away", () => {
    /*
      This test used to assert that an editable note had **no** grid at all.
      It does now: a table is drawn as a table while it is being written, and
      what the eye changes is whether its cells can be typed into — see
      `tableGrids`. The redraw-without-a-click that the test around it is
      about is still what is being pinned, one property along.
    */
    const TABLE = ["| a | b |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    const m = mount({ value: `# Notes\n\n${TABLE}`, editable: true });
    expect(m.container.querySelector(".cm-lp-grid-live")).not.toBeNull();
    expect(m.container.querySelector('[data-lp-row="0"]')?.getAttribute("contenteditable")).toBe(
      "true",
    );

    m.update({ editable: false });
    const grid = m.container.querySelector(".cm-lp-grid table");
    expect(grid).not.toBeNull();
    expect(m.container.querySelector(".cm-lp-grid-live")).toBeNull();
    expect(m.container.querySelector('[data-lp-row="0"]')?.getAttribute("contenteditable")).toBeNull();
    // The header's own cells, rather than the dashes that described them.
    expect([...(grid?.querySelectorAll("th") ?? [])].map((th) => th.textContent)).toEqual(["a", "b"]);
    expect(grid?.textContent).not.toContain("---");

    m.unmount();
  });

  test("and turning it back off puts the source back, also with no click", () => {
    const m = mount({ value: FORM, editable: false });
    expect(m.container.querySelector(".cm-lp-form")).not.toBeNull();

    m.update({ editable: true });
    expect(m.container.querySelector(".cm-lp-form")).toBeNull();
    expect(renderedText(m.container)).toContain("layout: table");

    m.unmount();
  });

  /**
   * THE TREE IS THE THIRD INPUT, AND IT ARRIVES BY A FOURTH ROUTE.
   *
   * `decorationsFor` reads the document, the selection and `readOnly` — but it
   * reads all three *through the syntax tree*, and on a note of any size that
   * tree is not there yet. CodeMirror parses roughly the first three thousand
   * characters up front and finishes the rest as idle work, announcing each
   * advance with a transaction that carries no document change, no selection
   * and no change of `readOnly`.
   *
   * So a note long enough to matter — which is most notes worth reading —
   * would draw its first screen and leave everything below it as raw markdown
   * until something else happened to invalidate the set. Same symptom as the
   * eye doing nothing, one input over.
   *
   * The test forces the parse rather than waiting for the idle callback,
   * because the callback only advances as far as the *viewport* and a jsdom
   * editor has no height to scroll. What is being pinned is the predicate: a
   * transaction whose only news is a longer tree must rebuild the decorations.
   */
  test("a table below the first parsed chunk becomes a grid when the parse reaches it", () => {
    const filler = Array.from(
      { length: 140 },
      (_, index) => `Paragraph ${index} of ordinary prose in this note.`,
    ).join("\n\n");
    const doc = `${filler}\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n`;

    const m = mount({ value: doc, editable: false });
    const view = viewIn(m.container);

    // The premise: the note really is longer than the first parse.
    expect(syntaxTreeAvailable(view.state, doc.length)).toBe(false);
    expect(gridsIn(view)).toBe(0);

    act(() => {
      forceParsing(view, doc.length, 5000);
    });

    expect(syntaxTree(view.state).length).toBe(doc.length);
    expect(gridsIn(view)).toBe(1);

    m.unmount();
  });

  /**
   * The narrow reading of the bug is "recompute on a reconfigure". The rule is
   * "recompute when the answer can have changed", and `readOnly` is the only
   * part of the configuration these decorations read — so a reconfigure that
   * leaves it alone must not throw the set away. The decorations are rebuilt
   * from the tree on every recompute, and doing that on configuration changes
   * that cannot matter is work on a path that already runs per keystroke.
   */
  test("a reconfigure that does not touch readOnly is not a redraw", () => {
    const m = mount({ value: FORM, editable: false });
    const before = m.container.querySelector(".cm-lp-form");
    expect(before).not.toBeNull();

    // Same value in: `editability(false)` again, a real reconfigure transaction
    // whose answer is identical.
    m.update({ editable: false });
    // The same DOM node, not an equal one — a rebuilt widget would lose
    // whatever somebody had typed into it. See `FormWidget.eq`.
    expect(m.container.querySelector(".cm-lp-form")).toBe(before);

    m.unmount();
  });
});
