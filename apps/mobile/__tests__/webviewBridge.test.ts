/**
 * @jest-environment jsdom
 */

/**
 * THE iOS EDITOR, END TO END, WITHOUT A PHONE.
 *
 * `LiveEditor.tsx` is a `WebView` whose contents are a real CodeMirror. The two
 * halves talk over JSON, and the parts worth proving are all in that
 * conversation rather than in either end:
 *
 *  - text goes across and comes back **byte for byte**, and a note nobody typed
 *    into never produces a `change` at all — which is what makes a save
 *    round-trip the file rather than rewrite it;
 *  - a note the viewer may not write refuses a **programmatic** edit, not just
 *    a keystroke;
 *  - the caret does not jump when the reducer echoes back what was just typed;
 *  - and `state.draft` goes dirty exactly when it should.
 *
 * None of that needs a simulator. `guest.ts` takes its bridge as an argument
 * and `host.ts` is a function over values, so the two can be wired to each
 * other in one process, with a real `EditorView` and a real lezer tree in the
 * middle. The only thing missing is WKWebView itself, which contributes no
 * behaviour to any of the above — it carries strings.
 *
 * What this therefore does NOT prove, and is verified on a device instead: the
 * keyboard, the caret staying above it, scroll physics, and how the note looks.
 */

import { describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { deleteCharBackward, insertNewline } from "@codemirror/commands";
import { mountGuest, applyTheme, type MountedGuest } from "../features/console/files/webview/guest";
import { guestStyles } from "../features/console/files/webview/styles";
import { createHostBridge, themeVars } from "../features/console/files/webview/host";
import { PROTOCOL_VERSION } from "../features/console/files/webview/protocol";
import { editorReducer, emptyEditor } from "../features/console/files/editor";
import { darkColors, lightColors } from "../features/design/tokens";

/**
 * A note with frontmatter, because that is the shape every note in a real
 * bucket has and the shape most likely to lose a byte: the closing `---`
 * parses as a setext underline, and the live-preview decorations treat the
 * whole block specially because of it.
 */
const NOTE = "---\nupdated: 2026-08-31\nstatus: active\n---\n\n# Title\n\nSome **bold** body.\n";

interface Wired {
  guest: MountedGuest;
  host: ReturnType<typeof createHostBridge>;
  view: EditorView;
  /** Every text the host's `onChange` was called with. */
  changes: string[];
  saves: number;
  /** Run whatever the guest has queued for the next frame. */
  flush: () => void;
  /** Deliver a raw payload as if the web view had posted it. */
  fromWebView: (raw: string) => void;
  destroy: () => void;
}

/**
 * Host and guest, connected to each other.
 *
 * The order matters and is the order React produces: the host's effects set the
 * document, the editability and the palette *before* the web view has loaded —
 * so all of it is sent into the void — and the guest then announces `ready`,
 * which is what makes the host resend the lot. A harness that set the state
 * after mounting would never exercise that, and the first thing a person would
 * see on a phone is an empty editor.
 */
function connect(initial: { doc: string; editable: boolean }): Wired {
  const root = document.createElement("div");
  document.body.appendChild(root);

  const changes: string[] = [];
  const counters = { saves: 0 };
  const frames: (() => void)[] = [];

  let deliver: (raw: string) => void = () => {};
  const host = createHostBridge((raw) => deliver(raw), {
    onChange: (text) => changes.push(text),
    onSave: () => {
      counters.saves += 1;
    },
  });

  host.setDoc(initial.doc);
  host.setEditable(initial.editable);
  host.setTheme(themeVars(darkColors, "Menlo", true));

  const guest = mountGuest(
    root,
    {
      post: (message) => host.receive(JSON.stringify(message)),
      listen: (handler) => {
        deliver = handler;
      },
      schedule: (flush) => frames.push(flush),
    },
    document.documentElement,
  );

  return {
    guest,
    host,
    view: guest.view,
    changes,
    get saves() {
      return counters.saves;
    },
    flush: () => {
      const queued = frames.splice(0, frames.length);
      for (const frame of queued) frame();
    },
    fromWebView: (raw) => host.receive(raw),
    destroy: () => {
      guest.destroy();
      root.remove();
    },
  } as Wired;
}

describe("text crosses and comes back unchanged", () => {
  test("the note the host set is the note the editor holds", () => {
    const w = connect({ doc: NOTE, editable: true });
    expect(w.view.state.doc.toString()).toBe(NOTE);
    w.destroy();
  });

  /**
   * THE test this file exists for.
   *
   * Opening a note must not produce a change. If it does, `editorReducer` marks
   * the draft dirty, the bottom bar lights up its Save, and a person who opened
   * a file to read it writes CodeMirror's idea of the file back over their own.
   */
  test("opening a note produces no change at all", () => {
    const w = connect({ doc: NOTE, editable: true });
    w.flush();
    expect(w.changes).toEqual([]);
    w.destroy();
  });

  test("nor does moving the caret through the frontmatter", () => {
    const w = connect({ doc: NOTE, editable: true });
    // Into the YAML, out the other side, and into the heading — every position
    // that changes which markup is revealed.
    for (const anchor of [0, 4, 20, NOTE.indexOf("# Title"), NOTE.indexOf("bold")]) {
      w.view.dispatch({ selection: { anchor } });
    }
    w.flush();
    expect(w.changes).toEqual([]);
    expect(w.view.state.doc.toString()).toBe(NOTE);
    w.destroy();
  });

  test("one typed character comes back as exactly that character inserted", () => {
    const w = connect({ doc: NOTE, editable: true });
    const at = NOTE.indexOf("body.") + "body".length;
    w.view.dispatch({ changes: { from: at, insert: "!" }, selection: { anchor: at + 1 } });
    w.flush();

    const expected = `${NOTE.slice(0, at)}!${NOTE.slice(at)}`;
    expect(w.changes).toEqual([expected]);
    // The frontmatter is byte-identical, fence to fence, including the newline
    // the closing fence sits on.
    expect(expected.slice(0, NOTE.indexOf("---\n\n") + 4)).toBe(
      NOTE.slice(0, NOTE.indexOf("---\n\n") + 4),
    );
    w.destroy();
  });

  test("a trailing newline survives the crossing", () => {
    // CodeMirror joins lines with "\n", so a document whose last character is a
    // newline has an empty final line. Losing it would rewrite every file in a
    // bucket the first time somebody typed in it.
    const w = connect({ doc: "one\ntwo\n", editable: true });
    w.view.dispatch({ changes: { from: 3, insert: "!" } });
    w.flush();
    expect(w.changes).toEqual(["one!\ntwo\n"]);
    w.destroy();
  });
});

describe("the caret", () => {
  /**
   * The parent re-renders with the *same* text — what happens on every
   * keystroke once `onChange` has run — and the editor must not be written to.
   * If it is, the document is replaced and the caret is thrown to the end.
   */
  test("the reducer echoing back what was just typed leaves it alone", () => {
    const w = connect({ doc: "hello world", editable: true });
    w.view.dispatch({ changes: { from: 5, insert: "X" }, selection: { anchor: 6 } });
    w.flush();
    expect(w.changes).toEqual(["helloX world"]);

    // The echo. `LiveEditor.tsx`'s effect calls this on every render.
    w.host.setDoc("helloX world");

    expect(w.view.state.doc.toString()).toBe("helloX world");
    expect(w.view.state.selection.main.head).toBe(6);
    w.destroy();
  });

  test("but text that genuinely came from outside is written in", () => {
    const w = connect({ doc: "first note", editable: true });
    w.host.setDoc("second note entirely");
    expect(w.view.state.doc.toString()).toBe("second note entirely");
    w.destroy();
  });
});

describe("a note the viewer may not write", () => {
  test("the readOnly facet is set, not just contenteditable", () => {
    const w = connect({ doc: NOTE, editable: false });
    expect(w.view.state.readOnly).toBe(true);
    expect(w.view.state.facet(EditorView.editable)).toBe(false);

    w.host.setEditable(true);
    expect(w.view.state.readOnly).toBe(false);
    w.destroy();
  });

  test("an editing command cannot change it", () => {
    const w = connect({ doc: NOTE, editable: false });
    w.view.dispatch({ selection: { anchor: w.view.state.doc.length } });

    // A command that checks the facet, and one that does not.
    //
    // `insertNewline` replaces the selection and returns `true` without looking
    // at `readOnly` — the facet is a convention that `@codemirror/commands`
    // itself already breaks. What refuses it is the `changeFilter` in
    // `editability`, which is why the assertion below is on the document rather
    // than on either return value.
    deleteCharBackward(w.view);
    insertNewline(w.view);
    w.flush();

    expect(w.view.state.doc.toString()).toBe(NOTE);
    expect(w.changes).toEqual([]);
    w.destroy();
  });

  /**
   * The one write a read-only note must still accept.
   *
   * `privacy.md` is read-only and still has to *open*, and a member reading a
   * note they cannot write still has to be able to open the next one. Both
   * arrive as a document replacement on a surface that refuses document
   * replacements, which is why they are annotated rather than exempted by a
   * second flag somebody has to remember to set.
   */
  test("but the app can still put a different note in front of the reader", () => {
    const w = connect({ doc: NOTE, editable: false });
    w.host.setDoc("# another note\n");
    expect(w.view.state.doc.toString()).toBe("# another note\n");
    w.flush();
    expect(w.changes).toEqual([]);
    w.destroy();
  });

  /**
   * THE SABOTAGE, SHIPPED RATHER THAN DESCRIBED.
   *
   * "A guard nobody has checked is not a guard." So rather than asserting that
   * the guard works and trusting that it is load-bearing, this builds the state
   * the way it was built before PR #158 — `EditorView.editable` and nothing
   * else — and proves the same command goes straight through it.
   *
   * If somebody drops `EditorState.readOnly` from `editability()`, the two
   * tests around this one fail and this one keeps passing, which is what says
   * the failure is real rather than an assertion that lost its subject.
   */
  test("and EditorView.editable alone would not have stopped it", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: NOTE,
        extensions: [EditorView.editable.of(false)],
      }),
    });
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    expect(deleteCharBackward(view)).toBe(true);
    expect(view.state.doc.toString()).not.toBe(NOTE);
    view.destroy();
  });

  /**
   * The second refusal, on the host's side of the process boundary.
   *
   * The guest cannot produce this message — the facet stops the edit before
   * there is anything to report — so this fakes one. "The other side checked"
   * is exactly the assumption that let a read-only drop rewrite a document for
   * a release, and the web view is a separate bundle that can be stale.
   */
  test("a change arriving anyway is dropped rather than reasoned about", () => {
    const w = connect({ doc: NOTE, editable: false });
    w.fromWebView(JSON.stringify({ v: PROTOCOL_VERSION, type: "change", text: "INJECTED" }));
    expect(w.changes).toEqual([]);

    // ...and a save on it is not forwarded either, because a Save that always
    // fails is worse than no Save.
    w.fromWebView(JSON.stringify({ v: PROTOCOL_VERSION, type: "save" }));
    expect(w.saves).toBe(0);

    // The gate is on `editable`, not a constant: the same messages land once
    // the viewer may write.
    w.host.setEditable(true);
    w.fromWebView(JSON.stringify({ v: PROTOCOL_VERSION, type: "change", text: "typed" }));
    w.fromWebView(JSON.stringify({ v: PROTOCOL_VERSION, type: "save" }));
    expect(w.changes).toEqual(["typed"]);
    expect(w.saves).toBe(1);
    w.destroy();
  });

  test("a payload that is not one of ours is ignored", () => {
    const w = connect({ doc: NOTE, editable: true });
    for (const raw of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ type: "change", text: "no version" }),
      JSON.stringify({ v: 99, type: "change", text: "wrong version" }),
      JSON.stringify({ v: PROTOCOL_VERSION, type: "eval", text: "unknown type" }),
    ]) {
      w.fromWebView(raw);
    }
    expect(w.changes).toEqual([]);
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
   * `.cm-lp-*` is exempt: those classes are this repository's own, are shared
   * verbatim with the web half, and CodeMirror has no rule for any of them.
   */
  test("every CodeMirror selector it sets is qualified by the host element", () => {
    const withoutComments = guestStyles().replace(/\/\*[\s\S]*?\*\//g, "");
    const unqualified = withoutComments
      .split("}")
      .map((block) => block.split("{")[0])
      .flatMap((head) => head.split(","))
      .map((selector) => selector.trim())
      .filter((selector) => selector.includes(".cm-"))
      .filter((selector) => !selector.includes(".cm-lp-"))
      .filter((selector) => !selector.startsWith("#root "));
    expect(unqualified).toEqual([]);
  });
});

describe("the palette", () => {
  test("both palettes reach the document, and a change of appearance is not a reload", () => {
    const w = connect({ doc: NOTE, editable: true });
    const read = (name: string) => document.documentElement.style.getPropertyValue(name);

    expect(read("--lp-bg")).toBe(darkColors.surface);

    const before = w.view.state.doc.toString();
    w.host.setTheme(themeVars(lightColors, "Menlo", true));
    expect(read("--lp-bg")).toBe(lightColors.surface);
    // The editor was reconfigured, not rebuilt: a colour change must not cost
    // the caret and the undo history.
    expect(w.view.state.doc.toString()).toBe(before);
    w.destroy();
  });

  test("the measure changes with the density, not with a second breakpoint", () => {
    expect(themeVars(darkColors, "Menlo", true)["--lp-size"]).toBe("16px");
    expect(themeVars(darkColors, "Menlo", false)["--lp-size"]).toBe("14.5px");
    // A phone reads the note; a pointer inspects it beside a file tree.
    expect(themeVars(darkColors, "Menlo", true)["--lp-content"]).toBe(darkColors.text);
    expect(themeVars(darkColors, "Menlo", false)["--lp-content"]).toBe(darkColors.text2);
  });

  test("only our own custom properties are written", () => {
    const target = document.createElement("div");
    applyTheme(target, {
      "--lp-bg": "#123456",
      // Not ours. A theme message is host-authored, but this is the one place a
      // string becomes CSS and a property name is the cheapest thing to bound.
      "--other": "#000",
      "background": "red",
    });
    expect(target.style.getPropertyValue("--lp-bg")).toBe("#123456");
    expect(target.style.getPropertyValue("--other")).toBe("");
    expect(target.style.background).toBe("");
  });
});
