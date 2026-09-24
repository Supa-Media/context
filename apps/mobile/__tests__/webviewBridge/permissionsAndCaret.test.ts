/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import {
  COMMANDS_THAT_WRITE,
  connect,
  createHostBridge,
  deleteCharBackward,
  EditorState,
  EditorView,
  insertNewline,
  NOTE,
  PROTOCOL_VERSION,
  runCommand,
} from "./fixtures";

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
