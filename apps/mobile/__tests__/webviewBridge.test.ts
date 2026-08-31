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
 *    a keystroke — and every key on the accessory bar is a programmatic edit;
 *  - the caret does not jump when the reducer echoes back what was just typed;
 *  - the accessory bar's commands cross as *names* and are run against the real
 *    editor state, so the selection and the undo history survive them;
 *  - focus crosses back, because a `WebView` has no `onFocus` of its own and
 *    `NoteEditor` decides whether to show the bar from one;
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
import {
  PROTOCOL_VERSION,
  type EditorCommand,
} from "../features/console/files/webview/protocol";
import { runCommand } from "../features/console/files/editorSetup";
import { splitNote } from "../features/console/files/frontmatter";
import { editorReducer, emptyEditor } from "../features/console/files/editor";
import { darkColors, lightColors } from "../features/design/tokens";

/**
 * Every command on the accessory bar that touches the document.
 *
 * Written out rather than derived from the bar's own key list, because a table
 * that is the same object the code uses asserts that the code equals itself.
 * `blur` is deliberately not here: it is the dismiss key, it writes nothing,
 * and the tests below require it to work on a note the others are refused on.
 */
const COMMANDS_THAT_WRITE: readonly EditorCommand[] = [
  { name: "wrap", before: "**", after: "**" },
  { name: "toggleLinePrefix", prefix: "# " },
  { name: "undo" },
  { name: "redo" },
];

/**
 * What CodeMirror has been told to keep clear at the bottom of the scroller.
 *
 * The facet holds functions, so the value has to be asked for rather than read.
 * This is `EditorView.scrollMargins` as CodeMirror itself consults it.
 */
function marginBelow(view: EditorView): number {
  return view.state
    .facet(EditorView.scrollMargins)
    .reduce((total, read) => total + (read(view)?.bottom ?? 0), 0);
}

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
  /** Every `focused` the host's `onFocus` was called with, in order. */
  focus: boolean[];
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
  const focus: boolean[] = [];
  const counters = { saves: 0 };
  const frames: (() => void)[] = [];

  let deliver: (raw: string) => void = () => {};
  const host = createHostBridge((raw) => deliver(raw), {
    onChange: (text) => changes.push(text),
    onSave: () => {
      counters.saves += 1;
    },
    onFocus: (focused) => focus.push(focused),
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
    focus,
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

/* -------------------------------------------------------------------------- */
/*                        the keyboard accessory bar                          */
/* -------------------------------------------------------------------------- */

/**
 * THE ACCESSORY BAR'S KEYS, ACROSS THE BRIDGE.
 *
 * On a phone the note is a `WebView`, and the bar is a native row of buttons
 * outside it. There is no `EditorView` on the React Native side to call, so a
 * key press crosses as a **name** and the guest runs the real CodeMirror
 * command against the real state.
 *
 * The alternative — string surgery on the host, sent back as text — is what a
 * `TextInput` forced and what this replaces. It fails three ways at once: the
 * host does not hold the selection, the round trip resets the caret, and text
 * arriving as a `doc` is *authoritative*, which is the one write a read-only
 * note still accepts. A bar built that way would edit `privacy.md`.
 */
describe("the accessory bar's commands", () => {
  test("bold wraps the selection where the selection actually is", () => {
    const w = connect({ doc: NOTE, editable: true });
    const at = NOTE.indexOf("body.");
    w.view.dispatch({ selection: { anchor: at, head: at + "body".length } });

    w.host.run({ name: "wrap", before: "**", after: "**" });
    w.flush();

    expect(w.view.state.doc.toString()).toBe(
      `${NOTE.slice(0, at)}**body**${NOTE.slice(at + "body".length)}`,
    );
    expect(w.changes).toEqual([w.view.state.doc.toString()]);
    // And the word is still selected, which is what makes a second press
    // (italic, say) land on the same word rather than on the markers.
    expect(w.view.state.selection.main.from).toBe(at + 2);
    expect(w.view.state.selection.main.to).toBe(at + 2 + "body".length);
    w.destroy();
  });

  test("italic on an empty selection leaves the caret between the markers", () => {
    const w = connect({ doc: "", editable: true });
    w.host.run({ name: "wrap", before: "*", after: "*" });
    w.flush();
    expect(w.view.state.doc.toString()).toBe("**");
    expect(w.view.state.selection.main.head).toBe(1);
    w.destroy();
  });

  test.each([
    ["heading", "# "],
    ["task", "- [ ] "],
  ])("%s puts its prefix on the caret's line, and takes it off again", (_name, prefix) => {
    const w = connect({ doc: NOTE, editable: true });
    const line = NOTE.indexOf("Some **bold**");
    w.view.dispatch({ selection: { anchor: line + 4 } });

    w.host.run({ name: "toggleLinePrefix", prefix });
    w.flush();
    expect(w.view.state.doc.toString()).toBe(
      `${NOTE.slice(0, line)}${prefix}${NOTE.slice(line)}`,
    );

    // Off again. A bar has one key per prefix, so the second press has to be
    // the undo the person means rather than `## `.
    w.host.run({ name: "toggleLinePrefix", prefix });
    w.flush();
    expect(w.view.state.doc.toString()).toBe(NOTE);
    w.destroy();
  });

  /**
   * Undo is CodeMirror's own, over the `history()` extension the keymap also
   * drives, rather than a stack of whole documents kept on the host.
   *
   * A second history is the failure mode that matters: on the one platform with
   * a hardware keyboard, ⌘Z and the bar's key would step through two different
   * pasts of the same note.
   */
  test("undo and redo move through the editor's own history", () => {
    const w = connect({ doc: "one", editable: true });
    w.view.dispatch({ changes: { from: 3, insert: " two" } });
    w.flush();
    expect(w.view.state.doc.toString()).toBe("one two");

    w.host.run({ name: "undo" });
    w.flush();
    expect(w.view.state.doc.toString()).toBe("one");

    w.host.run({ name: "redo" });
    w.flush();
    expect(w.view.state.doc.toString()).toBe("one two");
    w.destroy();
  });

  /**
   * THE ONE THAT WOULD HAND SOMEBODY AN EMPTY NOTE.
   *
   * The iOS editor is built empty and told its document over the bridge, so on
   * this platform *opening a file is a transaction* — and it was the first
   * entry in that file's undo history. One press of undo on a note nobody had
   * typed in undid the open, left an empty editor over somebody's note, and
   * reported the empty string as an edit for Save to write.
   *
   * Invisible until this branch, because the only route to undo was ⌘Z on a
   * desktop, where the first document is passed to `EditorState.create` and
   * never dispatched. The bar put an undo key under everybody's thumb.
   */
  test("undo on a note nobody has typed in does nothing at all", () => {
    const w = connect({ doc: NOTE, editable: true });
    w.host.run({ name: "undo" });
    w.flush();
    expect(w.view.state.doc.toString()).toBe(NOTE);
    expect(w.changes).toEqual([]);
    w.destroy();
  });

  test("nor does it reach back into the note that was open before this one", () => {
    const w = connect({ doc: "first note", editable: true });
    w.host.setDoc("second note entirely");
    w.view.dispatch({ changes: { from: 0, insert: "x" } });
    w.flush();

    w.host.run({ name: "undo" });
    w.host.run({ name: "undo" });
    w.host.run({ name: "undo" });
    w.flush();
    expect(w.view.state.doc.toString()).toBe("second note entirely");
    w.destroy();
  });

  test("dismiss lets go of the editing surface", () => {
    const w = connect({ doc: NOTE, editable: true });
    w.view.focus();
    expect(w.focus[w.focus.length - 1]).toBe(true);

    w.host.run({ name: "blur" });
    expect(w.focus[w.focus.length - 1]).toBe(false);
    w.destroy();
  });

  /**
   * THE ROUND TRIP, FOR A KEY PRESS RATHER THAN A KEYSTROKE.
   *
   * `NoteEditor` hands the editor the note's *body* on a phone and re-attaches
   * the frontmatter in front of every edit before it reaches `onChange`. That
   * only holds because a command's effect leaves here the same way typing does
   * — as an ordinary `change` carrying the whole buffer. A command that
   * reported its own result would be a second path into the draft, and the one
   * that skips the YAML block.
   *
   * So: split the note, edit the body with a bar key, reassemble, and require
   * the file back byte for byte apart from the two characters that were asked
   * for.
   */
  test("a command's effect comes back as an ordinary change, and the file reassembles", () => {
    const { frontmatter, body } = splitNote(NOTE);
    expect(frontmatter + body).toBe(NOTE);

    const w = connect({ doc: body, editable: true });
    const at = body.indexOf("bold");
    w.view.dispatch({ selection: { anchor: at, head: at + "bold".length } });

    w.host.run({ name: "wrap", before: "**", after: "**" });
    w.flush();

    expect(w.changes).toHaveLength(1);
    const saved = frontmatter + w.changes[0]!;
    expect(saved).toBe(
      `${NOTE.slice(0, NOTE.indexOf("bold"))}**bold**${NOTE.slice(NOTE.indexOf("bold") + 4)}`,
    );
    // Fence to fence, including the newline the closing fence sits on.
    expect(saved.startsWith(frontmatter)).toBe(true);
    w.destroy();
  });

  test("and a note nobody pressed anything on still crosses byte for byte", () => {
    const w = connect({ doc: NOTE, editable: true });
    // Toggling a prefix on and straight off again is the sharpest version: two
    // real transactions whose composition has to be the identity on the bytes.
    w.view.dispatch({ selection: { anchor: NOTE.indexOf("# Title") } });
    w.host.run({ name: "toggleLinePrefix", prefix: "# " });
    w.host.run({ name: "toggleLinePrefix", prefix: "# " });
    w.flush();
    expect(w.view.state.doc.toString()).toBe(NOTE);
    expect(w.changes[w.changes.length - 1]).toBe(NOTE);
    w.destroy();
  });
});

/**
 * EVERY ACCESSORY-BAR COMMAND IS A PROGRAMMATIC EDIT.
 *
 * Which is the exact thing `EditorView.editable.of(false)` does not stop, and
 * the reason `editability` has three facets rather than one. A bar of write
 * commands over `privacy.md`, or over a note somebody was invited into as a
 * reader, is not a cosmetic problem: it is a document rewritten on a surface
 * that reported itself inert.
 *
 * The bar is not rendered on such a note in the first place — `accessoryUp`
 * takes `editable` — and none of the three refusals below depends on that
 * staying true.
 */
describe("a command on a note the viewer may not write", () => {
  test("the host does not even send it", () => {
    const sent: string[] = [];
    const bridge = createHostBridge((raw) => sent.push(raw), {
      onChange: () => {},
      onSave: () => {},
    });
    bridge.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "ready" }));
    sent.length = 0;

    bridge.setEditable(false);
    sent.length = 0;
    for (const command of COMMANDS_THAT_WRITE) bridge.run(command);
    expect(sent).toEqual([]);

    // The gate is on `editable`, not a constant.
    bridge.setEditable(true);
    sent.length = 0;
    bridge.run({ name: "undo" });
    expect(sent).toHaveLength(1);
  });

  /** The dismiss key is the one that must never be refused. See `writesDocument`. */
  test("except the dismiss key, which writes nothing and is the only way out", () => {
    const sent: string[] = [];
    const bridge = createHostBridge((raw) => sent.push(raw), {
      onChange: () => {},
      onSave: () => {},
    });
    bridge.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "ready" }));
    bridge.setEditable(false);
    sent.length = 0;

    bridge.run({ name: "blur" });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: "command", command: { name: "blur" } });
  });

  /**
   * The second refusal, on the guest's side of the process boundary.
   *
   * The host will not send these, so this posts them straight into the guest.
   * "The other side checked" is the assumption that made
   * `EditorView.editable.of(false)` look sufficient for a year, and the guest
   * is a separate bundle that can be paired with a host it does not know.
   */
  test("and a command arriving anyway changes nothing", () => {
    const w = connect({ doc: NOTE, editable: false });
    w.view.dispatch({ selection: { anchor: NOTE.indexOf("bold"), head: NOTE.indexOf("bold") + 4 } });

    for (const command of COMMANDS_THAT_WRITE) {
      w.guest.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "command", command }));
    }
    w.flush();

    expect(w.view.state.doc.toString()).toBe(NOTE);
    expect(w.changes).toEqual([]);
    w.destroy();
  });

  /**
   * The third refusal, and the one that cannot be got round by a stale flag.
   *
   * `runCommand` reads `state.readOnly` off the live state rather than a
   * captured boolean, so a guest whose `editable` closure was somehow wrong
   * still refuses — and `editability`'s `changeFilter` refuses the transaction
   * underneath even that. This drives `runCommand` directly, past both of the
   * gates above, to prove the innermost one is real.
   */
  test("and running one directly against a read-only view is still refused", () => {
    const w = connect({ doc: NOTE, editable: false });
    w.view.dispatch({ selection: { anchor: 0, head: 4 } });

    for (const command of COMMANDS_THAT_WRITE) runCommand(w.view, command);
    w.flush();

    expect(w.view.state.doc.toString()).toBe(NOTE);
    expect(w.changes).toEqual([]);
    w.destroy();
  });

  /**
   * THE SABOTAGE, SHIPPED RATHER THAN DESCRIBED.
   *
   * The same move the `deleteCharBackward` test above makes, for the bar's own
   * commands: build the state the way it looked before `editability` grew its
   * second and third facets — `EditorView.editable` alone — and prove `wrap`
   * goes straight through it.
   *
   * If somebody drops `EditorState.readOnly` or the `changeFilter`, the three
   * tests above fail and this one keeps passing, which is what says the failure
   * is real rather than an assertion that lost its subject.
   */
  test("and EditorView.editable alone would not have stopped any of it", () => {
    const view = new EditorView({
      state: EditorState.create({ doc: NOTE, extensions: [EditorView.editable.of(false)] }),
    });
    view.dispatch({ selection: { anchor: 0, head: 4 } });

    // Not through `runCommand`, which asks `state.readOnly` — this state does
    // not set that facet, which is precisely the hole. The command body is what
    // is being shown to go through.
    view.dispatch(
      view.state.update(
        view.state.changeByRange((range) => ({
          changes: [
            { from: range.from, insert: "**" },
            { from: range.to, insert: "**" },
          ],
          range,
        })),
      ),
    );
    expect(view.state.doc.toString()).not.toBe(NOTE);
    view.destroy();
  });

  test("a command whose payload is not a command is ignored", () => {
    const w = connect({ doc: NOTE, editable: true });
    for (const command of [
      null,
      "wrap",
      { name: "evaluate", source: "1" },
      // The one that would land in somebody's note as `[object Object]`.
      { name: "wrap", before: { toString: () => "**" }, after: "**" },
      { name: "toggleLinePrefix" },
    ]) {
      w.guest.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "command", command }));
    }
    w.flush();
    expect(w.view.state.doc.toString()).toBe(NOTE);
    expect(w.changes).toEqual([]);
    w.destroy();
  });
});

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
