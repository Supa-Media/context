/**
 * @jest-environment jsdom
 */

/**
 * TWO OF THE SWEEP'S "CHEAP KEYMAP AND ATTRIBUTE WINS" — K1 AND P1.
 *
 * `1-projects/context-lc-editor-polish/ux-sweep.md` names both as needing no
 * product decision, only the fix:
 *
 *  - **K1.** Tab does nothing in a list. Verified there against a mounted
 *    editor: with the caret in `- one`, Tab left the document byte-identical,
 *    because `editorSetup.ts` bound `defaultKeymap` and `historyKeymap` only,
 *    and CM6 deliberately keeps `indentWithTab` out of its default set.
 *    Nesting a list meant typing spaces by hand.
 *  - **P1.** Spellcheck is off. `view.contentDOM` carries `spellcheck="false"`
 *    — CodeMirror's own default, right for a code editor and wrong for a notes
 *    editor typed and dictated on a phone.
 *
 * Both are mounted-editor assertions rather than pure-state ones: Tab is a
 * *keymap* binding, which only resolves through a real `EditorView`'s
 * `dispatch`-on-keydown path, and `spellcheck` is a DOM attribute nothing in
 * `livePreview.ts`'s pure decoration functions ever touches.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorExtensions } from "../features/console/files/editorSetup";

const views: EditorView[] = [];
afterEach(() => {
  while (views.length > 0) views.pop()!.destroy();
});

function mount(doc: string, cursor: number, extra: Extension[] = []): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [
        ...editorExtensions({
          editable: true,
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

/** Dispatch a real `keydown` at the content DOM, the way a keyboard does. */
function press(view: EditorView, key: string, shift = false): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true, cancelable: true }),
  );
}

describe("K1 — Tab indents a list item, Shift-Tab outdents it", () => {
  test("Tab with the caret in `- one` inserts indentation rather than doing nothing", () => {
    const view = mount("- one", 2 /* caret inside "one", after "- " */);
    press(view, "Tab");
    // indentMore's unit is whitespace at the start of the line; the exact
    // width is CodeMirror's own default and not this fix's to pin — what
    // matters is that the document actually changed, which it did not before.
    expect(view.state.doc.toString()).not.toBe("- one");
    expect(view.state.doc.toString().startsWith(" ")).toBe(true);
  });

  test("Shift-Tab removes indentation Tab just added", () => {
    const view = mount("- one", 2);
    press(view, "Tab");
    const indented = view.state.doc.toString();
    expect(indented).not.toBe("- one");
    press(view, "Tab", true);
    expect(view.state.doc.toString()).toBe("- one");
  });

  test("a read-only note refuses Tab, same as every other edit", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: "- one",
        selection: { anchor: 2 },
        extensions: editorExtensions({
          editable: false,
          editableCompartment: new Compartment(),
          handlers: { current: { onChange: () => {}, onSave: () => {} } },
        }),
      }),
      parent,
    });
    views.push(view);
    press(view, "Tab");
    expect(view.state.doc.toString()).toBe("- one");
  });
});

describe("P1 — the note editor accepts spellcheck", () => {
  test("the content DOM is not marked spellcheck=false", () => {
    const view = mount("hello wrold", 0);
    // jsdom reflects the attribute onto the boolean property; asserting the
    // attribute directly is what actually distinguishes "on" from "absent",
    // since a missing attribute and `spellcheck="true"` both read `true` off
    // the property in some environments.
    expect(view.contentDOM.getAttribute("spellcheck")).toBe("true");
  });
});
