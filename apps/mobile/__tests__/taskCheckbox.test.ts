/**
 * @jest-environment jsdom
 */

/**
 * A CHECKBOX IS A CONTROL, NOT A CHARACTER.
 *
 * The first version of this drew U+2610 and U+2611 and looked, in the owner's
 * words, like "plain text" — which was exactly right, because that is what a
 * character in the body font is. It took the surrounding weight, it was a
 * different shape in every font that had it, and nothing about it said it could
 * be pressed.
 *
 * `livePreview.test.ts` proves *where* a box is drawn and which tasks are
 * struck through, over a tree and a selection, with no DOM. This file proves
 * the three things that only exist once one is mounted:
 *
 *  - the box is a **drawn element** with the state on it, not text;
 *  - pressing it rewrites the three characters in the buffer, and pressing the
 *    box rather than the padding around it does so — the first version of the
 *    handler tested the class on the event target alone, so a press on the
 *    drawn box *inside* the widget did nothing;
 *  - a read-only note refuses.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests here.
 *
 *   `closest` narrowed back to `classList.contains` on the target      3
 *   the widget's `eq` ignoring `checked`, so the box keeps stale DOM   1
 *   the read-only guard dropped                                       1
 *
 * Two of those went undetected on the first pass and are worth recording
 * rather than quietly fixing. **The read-only guard** was invisible because
 * `changeFilter` drops the changes anyway, so the document was unchanged with
 * the guard deleted — the transaction count is what separates the guard from
 * the filter. **`preventDefault()`** is genuinely redundant: CodeMirror
 * prevents the default for any handler returning truthy, so no test can
 * distinguish it and the line stays as belt and braces rather than as
 * something claimed to be covered.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorExtensions } from "../features/console/files/editorSetup";

const views: EditorView[] = [];
afterEach(() => {
  while (views.length > 0) views.pop()!.destroy();
});

function mount(doc: string, editable = true, extra: Extension[] = []): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      // Parked on the last line, which is prose: a caret on a task's own line
      // reveals its markup and there would be no box to press.
      selection: { anchor: doc.length },
      extensions: [
        ...editorExtensions({
          editable,
          editableCompartment: new Compartment(),
          handlers: { current: { onChange: () => {}, onSave: () => {} } },
        }),
        ...extra,
      ],
    }),
    parent,
  });
  views.push(view);
  return view;
}

const NOTE = ["- [ ] still to do", "- [x] already done", "", "elsewhere"].join("\n");

/** Every checkbox on screen, in document order. */
function boxes(view: EditorView): HTMLElement[] {
  return [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-lp-task")];
}

/** Press the drawn box *inside* a widget, which is where a finger lands. */
function press(widget: HTMLElement): void {
  const box = widget.querySelector(".cm-lp-task-box") ?? widget;
  box.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}

describe("the box is drawn, not written", () => {
  test("a checkbox is an element carrying its own state", () => {
    const drawn = boxes(mount(NOTE));
    expect(drawn).toHaveLength(2);
    expect(drawn.map((node) => node.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    expect(drawn.map((node) => node.classList.contains("cm-lp-task-on"))).toEqual([false, true]);
  });

  test("it announces itself as a checkbox", () => {
    // Over the raw text a screen reader says "left bracket x right bracket".
    expect(boxes(mount(NOTE)).map((node) => node.getAttribute("role"))).toEqual([
      "checkbox",
      "checkbox",
    ]);
  });

  test("it holds a drawn box rather than a character", () => {
    const [first] = boxes(mount(NOTE));
    expect(first.querySelector(".cm-lp-task-box")).not.toBeNull();
    // No text content at all: whatever is on screen is CSS, so it cannot fall
    // back to a missing-glyph rectangle on a device without the font.
    expect(first.textContent).toBe("");
  });
});

describe("pressing one ticks it", () => {
  test("a press on the drawn box rewrites the marker", () => {
    const view = mount(NOTE);
    press(boxes(view)[0]);
    expect(view.state.doc.toString()).toBe(NOTE.replace("- [ ] still", "- [x] still"));
  });

  test("and pressing a ticked one clears it", () => {
    const view = mount(NOTE);
    press(boxes(view)[1]);
    expect(view.state.doc.toString()).toBe(NOTE.replace("- [x] already", "- [ ] already"));
  });

  test("the box redraws to match", () => {
    const view = mount(NOTE);
    press(boxes(view)[0]);
    expect(boxes(view)[0].getAttribute("aria-checked")).toBe("true");
  });

  test("the press is claimed, so it does not also place a caret in the marker", () => {
    /*
      Without this the press falls through, the caret lands inside `[x]`, the
      reveal rule fires, and the box the person just pressed is replaced by the
      three characters it stands for.

      This does **not** isolate the handler's own `preventDefault()` call:
      CodeMirror prevents the default itself for any handler that returns
      truthy, so deleting that line changes nothing observable. The explicit
      call stays for the reason `noteLinks` gives — a library convention is not
      a guarantee — and what is pinned here is the outcome.
    */
    const view = mount(NOTE);
    const box = boxes(view)[0].querySelector(".cm-lp-task-box") ?? boxes(view)[0];
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    box.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  test("a read-only note is not written", () => {
    const view = mount(NOTE, false);
    press(boxes(view)[0]);
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  test("and nothing is dispatched at all — the guard, not just the filter", () => {
    /*
      The test above passes with the read-only guard deleted, because
      `editability`'s `changeFilter` drops the changes and the document is
      unchanged either way. That is the filter doing its job, not this handler
      declining — and the handler's own comment claims something stronger:
      that it refuses *before* dispatching, because a refused transaction still
      moves the selection and lands in the undo history.

      Counting the handler's own transactions is what tells the two apart —
      `isUserEvent("input")` rather than a bare count, because a press that
      falls through to CodeMirror still produces a selection transaction and
      that one is not this handler's.
    */
    let writes = 0;
    const view = mount(NOTE, false, [
      EditorView.updateListener.of((update) => {
        writes += update.transactions.filter((one) => one.isUserEvent("input")).length;
      }),
    ]);
    writes = 0;
    press(boxes(view)[0]);
    expect(writes).toBe(0);
  });

  test("a press elsewhere in the note changes nothing", () => {
    /*
      Asserted on the document rather than on `defaultPrevented`: CodeMirror's
      own mousedown handler claims the event to run its selection logic, so a
      press anywhere in the content is prevented whatever this handler decides.
      What is being pinned is that the handler declines — not that nobody else
      wanted the event.
    */
    const view = mount(NOTE);
    view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe(NOTE);
  });
});
