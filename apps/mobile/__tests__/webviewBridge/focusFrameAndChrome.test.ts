/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { caretBox, connect, editorReducer, emptyEditor, guestStyles, marginBelow, NOTE } from "./fixtures";


/**
 * FOCUS, WHICH A `WebView` DOES NOT HAVE.
 *
 * `NoteEditor` renders the accessory bar from `onFocus`/`onBlur`, and it used
 * to get them from a `TextInput`. A `WebView` is one native view whose first
 * responder is an implementation detail and it emits neither — so the guest
 * listens on CodeMirror's own `contentDOM`, exactly as the web half does, and
 * the answer crosses the bridge.
 *
 * This matters more here than it looks. There is no drag-to-dismiss on this
 * surface — the outer scroll view is off so CodeMirror's scroller is the only
 * one — so the bar is the *only* way out of the keyboard. A focus report that
 * never arrived would be a person trapped in the keyboard.
 */
describe("focus crosses the bridge", () => {
  test("taking and losing the caret both arrive, in order", () => {
    const w = connect({ doc: NOTE, editable: true });
    expect(w.focus).toEqual([]);

    w.view.focus();
    w.view.contentDOM.blur();

    expect(w.focus).toEqual([true, false]);
    w.destroy();
  });

  /**
   * A note the viewer may not write still reports focus, and that is not a
   * contradiction of the refusals above: focus is not an edit. The bar is kept
   * off such a note by `accessoryUp`'s `editable` condition, one layer up,
   * where the decision is about what to *show* rather than about what to allow.
   */
  test("and a read-only note reports it too, because focus is not an edit", () => {
    const w = connect({ doc: NOTE, editable: false });
    w.view.focus();
    expect(w.focus).toEqual([true]);
    w.destroy();
  });

  /**
   * A table cell is `contenteditable` DOM belonging to a widget, so the caret
   * being in a grid means `contentDOM` does **not** have focus. Reported as a
   * blur, tapping a cell would put the keyboard up and take away the accessory
   * bar, which on this surface is the only way back out of the keyboard.
   */
  test("a caret in a table cell is a caret in the note", () => {
    const w = connect({ doc: "| a | b |\n| --- | --- |\n| 1 | 2 |\n", editable: true });
    const cell = w.view.dom.querySelector<HTMLElement>('[data-lp-row="0"][data-lp-column="0"]');
    expect(cell).not.toBeNull();

    cell?.focus();
    expect(w.focus).toEqual([true]);

    // Moving to the next cell is not leaving the note, so nothing is said.
    const second = w.view.dom.querySelector<HTMLElement>('[data-lp-row="0"][data-lp-column="1"]');
    second?.focus();
    expect(w.focus).toEqual([true]);

    // Leaving the note entirely is, and it is the second cell that holds the
    // caret by now — blurring the first would be blurring nothing.
    second?.blur();
    expect(w.focus).toEqual([true, false]);
    w.destroy();
  });

  /**
   * jsdom lays nothing out, so what this pins is **which branch answers**: a
   * focused cell measures the element, and `coordsAtPos` — which needs the
   * range APIs jsdom does not have — answers nothing. On a phone the
   * difference is whether the keyboard ends up over the cell being typed in or
   * over a line nobody is looking at.
   */
  test("and the caret it measures is the cell, not the selection behind it", () => {
    const w = connect({ doc: "| a | b |\n| --- | --- |\n| 1 | 2 |\n", editable: true });
    expect(caretBox(w.view)).toBeNull();

    w.view.dom.querySelector<HTMLElement>('[data-lp-row="0"][data-lp-column="0"]')?.focus();
    expect(caretBox(w.view)).not.toBeNull();
    w.destroy();
  });

  test("nothing is reported once the editor is gone", () => {
    const w = connect({ doc: NOTE, editable: true });
    w.view.focus();
    w.focus.length = 0;
    w.destroy();
    expect(w.focus).toEqual([]);
  });
});

/**
 * THE CARET, AND THE KEYBOARD SITTING ON IT.
 *
 * Nothing about a WKWebView shrinks when the keyboard opens: the web view keeps
 * its full height, the keyboard is drawn over it, and CodeMirror — which
 * measures its scroller's client rectangle — believes the whole note is
 * visible. Padding the scroller makes it *possible* to scroll the last line
 * clear; the scroll margin is what makes CodeMirror actually do so, on its own
 * scrolls as well as ours.
 *
 * What can be checked here is the plumbing: that the number reaches both places
 * and that the arithmetic that produces it is right. **What cannot** is whether
 * the caret is visible on a phone, which needs a phone; see the report.
 */
describe("the keyboard inset", () => {
  test("reaches the scroller as padding and CodeMirror as a scroll margin", () => {
    const w = connect({ doc: NOTE, editable: true });

    w.host.setInset(320);
    expect(document.documentElement.style.getPropertyValue("--lp-inset-bottom")).toBe("320px");
    expect(marginBelow(w.view)).toBe(320);

    // And it goes away again rather than leaving a note that cannot be scrolled
    // to its own last line.
    w.host.setInset(0);
    expect(document.documentElement.style.getPropertyValue("--lp-inset-bottom")).toBe("0px");
    expect(marginBelow(w.view)).toBe(0);
    w.destroy();
  });

  /**
   * The facet is read at *measure* time rather than captured, which is what
   * lets the inset change without reconfiguring the editor — and reconfiguring
   * is what would cost the caret and the undo history every time the keyboard
   * opened.
   */
  test("a change of inset is not a reconfiguration", () => {
    const w = connect({ doc: NOTE, editable: true });
    w.view.dispatch({ changes: { from: 0, insert: "x" } });
    w.flush();
    const before = w.view.state.doc.toString();

    w.host.setInset(291);
    expect(w.view.state.doc.toString()).toBe(before);
    expect(marginBelow(w.view)).toBe(291);
    w.destroy();
  });
});

describe("the dirty-state contract", () => {
  /**
   * The bridge's output is fed to the real reducer, because "dirty" is not a
   * property of the editor — it is `editorReducer` comparing the draft against
   * the baseline, and the only thing that can break it from here is text that
   * does not come back the way it went in.
   */
  test("clean on open, dirty on a keystroke, clean again when it is undone", () => {
    const w = connect({ doc: NOTE, editable: true });
    let state = editorReducer(emptyEditor, {
      type: "opened",
      note: {
        path: "note.md",
        text: NOTE,
        etag: "1",
        visibility: "private",
        inherited: "private",
        exception: false,
        readOnly: false,
      },
    });
    expect(state.status).toBe("clean");

    // Nothing was typed, so nothing crossed, so the draft is untouched.
    w.flush();
    expect(w.changes).toEqual([]);
    expect(state.draft).toBe(NOTE);

    w.view.dispatch({ changes: { from: 0, insert: "x" } });
    w.flush();
    state = editorReducer(state, { type: "edited", text: w.changes[w.changes.length - 1] });
    expect(state.status).toBe("dirty");

    w.view.dispatch({ changes: { from: 0, to: 1 } });
    w.flush();
    state = editorReducer(state, { type: "edited", text: w.changes[w.changes.length - 1] });
    expect(state.status).toBe("clean");
    expect(state.draft).toBe(NOTE);
    w.destroy();
  });
});

describe("one message per frame", () => {
  /**
   * A burst — a paste, an autocorrect replacement, an IME commit, a fast
   * typist — must not be one `postMessage`, one JSON parse and one React
   * re-render of the console per character.
   *
   * A *timer* debounce would also collapse the burst and would be wrong in a
   * way that is easy to miss: `state.draft` is what Save writes, so a window
   * during which the host holds stale text is a window in which typing and then
   * tapping Save saves the previous text. One frame is short enough that no
   * finger can get inside it.
   */
  test("a burst of edits is one change, carrying the last text", () => {
    const w = connect({ doc: "", editable: true });
    for (const character of "burst") {
      w.view.dispatch({ changes: { from: w.view.state.doc.length, insert: character } });
    }
    expect(w.changes).toEqual([]);

    w.flush();
    expect(w.changes).toEqual(["burst"]);
    w.destroy();
  });

  /**
   * The queued post reads the current text at flush time rather than capturing
   * it when it was queued.
   *
   * The case: somebody types, and before the frame lands a conflict resolves
   * and loads somebody else's version. A captured text would report the text
   * that was just thrown away, the host would take that as the draft, and the
   * two ends would be holding different documents with nothing to notice it.
   */
  test("a document replaced while a change was queued reports the replacement", () => {
    const w = connect({ doc: "draft", editable: true });
    w.view.dispatch({ changes: { from: 5, insert: " more" } });
    w.host.setDoc("their version");
    w.flush();

    expect(w.view.state.doc.toString()).toBe("their version");
    expect(w.changes[w.changes.length - 1]).toBe("their version");
    expect(w.host.known()).toBe(w.view.state.doc.toString());
    w.destroy();
  });
});

describe("the stylesheet outranks CodeMirror's own", () => {
  /**
   * CodeMirror injects its base theme through style-mod when the view is
   * *constructed*, which is after the guest has appended its own stylesheet to
   * the head. At equal specificity the later sheet wins — so `.cm-scroller`
   * against CodeMirror's `.cm-scroller { font-family: monospace }` loses, and
   * the whole note renders in a code face with the wrong line box. That is what
   * the first screenshot of this editor showed.
   *
   * An id selector beats a class and does not depend on append order. This
   * asserts it structurally rather than trusting a comment, because jsdom does
   * not resolve the cascade well enough to assert it any other way and a
   * screenshot is not a test.
   *
   * Classes this repository invented are exempt, and the exemption is a rule
   * rather than a list: they are shared verbatim with the web half, and
   * CodeMirror has no rule for any of them, so there is no cascade to lose.
   * What the test is actually about is *CodeMirror's own* class names —
   * `.cm-scroller`, `.cm-content`, `.cm-cursor` — every one of which it themes
   * itself and every one of which must therefore be out-specified.
   *
   * Keep `OURS` to prefixes this repository defines. A name CodeMirror also
   * uses does not become safe by being added here.
   */
  test("every CodeMirror selector it sets is qualified by the host element", () => {
    const OURS = [".cm-lp-", ".cm-dictation-"];
    const withoutComments = guestStyles().replace(/\/\*[\s\S]*?\*\//g, "");
    const unqualified = withoutComments
      .split("}")
      .map((block) => block.split("{")[0])
      .flatMap((head) => head.split(","))
      .map((selector) => selector.trim())
      .filter((selector) => selector.includes(".cm-"))
      .filter((selector) => !OURS.some((prefix) => selector.includes(prefix)))
      .filter((selector) => !selector.startsWith("#root "));
    expect(unqualified).toEqual([]);
  });
});
