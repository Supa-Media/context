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
import { editability, editorExtensions } from "../features/console/files/editorSetup";

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

/**
 * Dispatch a real `keydown` at the content DOM, the way a keyboard does.
 * Returns whether the event's default was prevented — CodeMirror only calls
 * `preventDefault()` when a binding actually handled the key, so this is how
 * a test tells "Tab moved focus" (unhandled) from "Tab was intercepted"
 * (handled) without a real DOM to observe focus movement in.
 */
/**
 * `Mod-` is ⌘ on Apple and Ctrl everywhere else, and CodeMirror decides which
 * from the platform it is running on rather than from anything this test can
 * pass it. jsdom is not a Mac, so a `metaKey` here would build `Cmd-b` and
 * match nothing — which is a test that passes for the wrong reason the day
 * somebody reads its name and believes it.
 */
const MAC = /Mac|iP(hone|[oa]d)/.test(
  (navigator as { platform?: string }).platform ?? "",
);

function press(view: EditorView, key: string, shift = false, mod = false): boolean {
  const event = new KeyboardEvent("keydown", {
    key,
    shiftKey: shift,
    metaKey: mod && MAC,
    ctrlKey: mod && !MAC,
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
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

  test("Tab outside a list keeps its previous behaviour: unhandled, document untouched", () => {
    // Two paragraphs separated by a blank line, so the second is not a lazy
    // continuation of any list — plain prose with no list ancestor at all.
    const doc = "- one\n\nplain paragraph";
    const view = mount(doc, doc.indexOf("plain") + 2);
    const prevented = press(view, "Tab");
    // Unhandled: CodeMirror never called `preventDefault`, so the browser's
    // own Tab behaviour (move focus to the next control) still applies —
    // exactly what happened here before K1 added any binding at all.
    expect(prevented).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });

  test("Shift-Tab outside a list is equally unhandled", () => {
    const doc = "plain paragraph, no list anywhere in this note";
    const view = mount(doc, 5);
    const prevented = press(view, "Tab", true);
    expect(prevented).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
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

describe("R3 — highlighting never edits the buffer", () => {
  test("opening a note with JS, HTML and CSS fences leaves the buffer byte-identical", () => {
    // Through the real, mounted editor rather than `decorationsFor` alone —
    // `livePreview.test.ts` already proves the pure decoration functions
    // don't touch the doc; this proves the same of the whole configuration
    // `editorExtensions` assembles, `codeHighlighting()` included, the way a
    // note actually opens.
    const doc = [
      "# Notes",
      "",
      "```js",
      "const x = 1; // running total",
      "```",
      "",
      "```html",
      "<div class=\"x\">hi</div>",
      "```",
      "",
      "```css",
      ".x { color: red; }",
      "```",
    ].join("\n");
    const view = mount(doc, 0);
    // Moving the caret through the document is what a person opening a note
    // and reading it does, and it's also what makes Live Preview recompute
    // its decorations — the moment a stray edit would show up if one existed.
    for (let pos = 0; pos <= doc.length; pos += 7) {
      view.dispatch({ selection: { anchor: pos } });
    }
    expect(view.state.doc.toString()).toBe(doc);
  });
});


/**
 * ⌘B, ⌘I AND ⌘⇧X — THE CHORDS SOMEBODY ACTUALLY ASKED FOR.
 *
 * Bound here rather than in the web half, even though a phone has no keyboard,
 * because an iPad with a hardware keyboard runs the native editor: the same
 * configuration compiled into the guest bundle. A chord that bolds on one host
 * and does nothing on the other is the drift `editorSetup.ts` exists to
 * prevent, and only a test against the *shared* extension list can say which
 * one this is.
 */
describe("the marker chords", () => {
  test("⌘B wraps the selection, and ⌘B again takes it back", () => {
    const view = mount("some words here", 0);
    view.dispatch({ selection: { anchor: 5, head: 10 } });

    expect(press(view, "b", false, true)).toBe(true);
    expect(view.state.doc.toString()).toBe("some **words** here");

    expect(press(view, "b", false, true)).toBe(true);
    expect(view.state.doc.toString()).toBe("some words here");
  });

  test("⌘I is italic and ⌘⇧X is strikethrough", () => {
    const view = mount("some words here", 0);
    view.dispatch({ selection: { anchor: 5, head: 10 } });
    press(view, "i", false, true);
    expect(view.state.doc.toString()).toBe("some *words* here");

    const other = mount("some words here", 0);
    other.dispatch({ selection: { anchor: 5, head: 10 } });
    press(other, "x", true, true);
    expect(other.state.doc.toString()).toBe("some ~~words~~ here");
  });

  /**
   * **Ctrl-B and Ctrl-I are live browser chords in Firefox** — the bookmarks
   * sidebar and the page info window. So the read-only arm returns `true` and
   * swallows the key rather than letting it through: a note somebody may only
   * read is exactly where they are most likely to press one by habit, and
   * answering with a sidebar over their note is worse than answering with
   * nothing. The same argument `Mod-s` makes one binding above.
   */
  test("a read-only note answers with nothing, and still swallows the key", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: "some words here",
        selection: { anchor: 5, head: 10 },
        extensions: editorExtensions({
          editable: false,
          editableCompartment: new Compartment(),
          handlers: { current: { onChange: () => {}, onSave: () => {} } },
        }),
      }),
      parent,
    });
    views.push(view);

    expect(press(view, "b", false, true)).toBe(true);
    expect(view.state.doc.toString()).toBe("some words here");
  });

  /**
   * The sabotage this pins: `editability`'s `changeFilter` is the gate that
   * holds when a command forgets to ask. Built with `EditorView.editable`
   * alone — the facet CodeMirror's own documentation warns is not enough — the
   * same keystroke goes straight through.
   */
  test("and the changeFilter, not the facet, is what actually refuses it", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: "some words here",
        selection: { anchor: 5, head: 10 },
        extensions: editorExtensions({
          editable: true,
          editableCompartment: new Compartment(),
          handlers: { current: { onChange: () => {}, onSave: () => {} } },
        }),
      }),
      parent,
    });
    views.push(view);

    // Editable, so the chord writes — which is the control for the arm above.
    press(view, "b", false, true);
    expect(view.state.doc.toString()).toBe("some **words** here");

    // And the filter alone, with no command checking anything, still refuses.
    const guarded = new EditorView({
      state: EditorState.create({
        doc: "some words here",
        extensions: [editability(false)],
      }),
    });
    guarded.dispatch({ changes: { from: 0, insert: "x" } });
    expect(guarded.state.doc.toString()).toBe("some words here");
    guarded.destroy();
  });
});
