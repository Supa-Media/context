/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { connect, NOTE, splitNote } from "./fixtures";

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
   * A2: `link` is the sixth verb in `EditorCommand`, and this is its own
   * pass through the same real-bridge-real-EditorView harness the other five
   * get — not the `NoteAccessory.tsx` mock, which only proves the key calls
   * `controls.insertLink()`.
   *
   * Selected text is dropped rather than wrapped — `[[some text]]` names
   * nothing — so this is the one accessory command in the file whose
   * assertion is deliberately *not* "selection preserved" the way `wrap`'s is
   * above.
   */
  test("link inserts [[]] at the caret and drops the selection, without dropping focus", () => {
    const w = connect({ doc: NOTE, editable: true });
    w.view.focus();
    const at = NOTE.indexOf("Some **bold**");
    w.view.dispatch({ selection: { anchor: at, head: at + "Some".length } });
    const focusEventsBefore = w.focus.length;

    w.host.run({ name: "insertLink" });
    w.flush();

    expect(w.view.state.doc.toString()).toBe(
      `${NOTE.slice(0, at)}[[]]${NOTE.slice(at + "Some".length)}`,
    );
    // Between the brackets, not wrapping the four characters that were
    // selected — those are gone rather than sitting inside `[[Some]]`.
    expect(w.view.state.selection.main.anchor).toBe(at + 2);
    expect(w.view.state.selection.main.head).toBe(at + 2);
    expect(w.changes).toEqual([w.view.state.doc.toString()]);
    // THE FAKE-KEYBOARD CHECK: running a bar command is a `postMessage` round
    // trip on the one platform where the keyboard is a WebView's own
    // `contentDOM` having focus. A command that cost that focus would drop
    // the keyboard out from under whoever pressed the key — this bridge has
    // no simulator to catch that on, so what is asserted is the one thing
    // that would show it here: no further `onFocus` report crossed at all.
    expect(w.focus.slice(focusEventsBefore)).toEqual([]);
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
    /*
      `body`, not `bold`. The fixture's `bold` is already inside a pair of
      asterisks, and `wrap` is a **toggle** now (`markdownFormat.ts`) — pressing
      Bold on an already-bold word takes the markers off, which is the point of
      the change and the wrong thing for a test about the round trip to be
      measuring. The toggle's own behaviour is asserted just below.
    */
    const at = body.indexOf("body");
    w.view.dispatch({ selection: { anchor: at, head: at + "body".length } });

    w.host.run({ name: "wrap", before: "**", after: "**" });
    w.flush();

    expect(w.changes).toHaveLength(1);
    const saved = frontmatter + w.changes[0]!;
    expect(saved).toBe(
      `${NOTE.slice(0, NOTE.indexOf("body"))}**body**${NOTE.slice(NOTE.indexOf("body") + 4)}`,
    );
    // Fence to fence, including the newline the closing fence sits on.
    expect(saved.startsWith(frontmatter)).toBe(true);
    w.destroy();
  });

  /**
   * The bar's Bold key means what ⌘B means, across the bridge.
   *
   * It used to insert a pair and nothing took one off, so a second press on the
   * same word produced `****word****`. The guest runs `runCommand`, which runs
   * the same `toggleWrap` the desktop keymap runs, so this is the one place
   * that can prove the phone got the same verb rather than a lookalike.
   */
  test("and pressing the same key again takes the markers off, over the bridge", () => {
    const w = connect({ doc: "Some **bold** body.\n", editable: true });
    const at = "Some **".length;
    w.view.dispatch({ selection: { anchor: at, head: at + "bold".length } });

    w.host.run({ name: "wrap", before: "**", after: "**" });
    w.flush();
    expect(w.view.state.doc.toString()).toBe("Some bold body.\n");

    w.host.run({ name: "wrap", before: "**", after: "**" });
    w.flush();
    expect(w.view.state.doc.toString()).toBe("Some **bold** body.\n");
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
