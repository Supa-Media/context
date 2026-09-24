/**
 * The collaborative binding's life in the web editor: taken down when a
 * different note opens, and put up once the room and the editor agree on the
 * text.
 *
 * Plain functions, each the body of one effect in `LiveEditor.web.tsx`. The
 * effects themselves, with their order, their dependencies and their
 * cleanups, stay in the component where React runs them.
 */

import type { Compartment } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import { setCaretDocument } from "../../presence/remoteCarets";
import type { SharedDoc } from "../../presence/sharedDoc";
import { replaceDocument } from "../editorSetup";
import type { LiveEditorProps } from "./contract";

/**
 * Take the collaborative binding out, in a transaction that changes nothing
 * else.
 *
 * Its own dispatch for two reasons, and both of them have cost a note: while
 * the binding is up every document change is relayed into that room, so the
 * editor must be out of the room *before* another note is written into it; and
 * CodeMirror keeps a `ViewPlugin` value across a reconfiguration that still
 * contains the plugin, so a binding replaced in one dispatch keeps the
 * `Y.Text` it was built with. Removing it and adding it back are therefore two
 * transactions, which is what makes the second one a genuinely new plugin.
 *
 * Idempotent: an empty compartment reconfigured to empty is a transaction with
 * no document change, which `YSyncPluginValue.update` ignores.
 */
export function unbind(view: EditorView, collab: Compartment): void {
  view.dispatch({ effects: [collab.reconfigure([]), setCaretDocument.of(null)] });
}

/*
  A different note was opened, and the room bound here is the one being left.

  **This is the fix for "the note I clicked is not the note on screen".** The
  room for a note is created by `usePresence` in the *parent's* effect, and a
  child's effects run first — so the commit that brings the new note's `value`
  and `notePath` down still carries the previous note's `presence.shared`. The
  effect below stands down while a document is bound, correctly and for the
  reason its own comment gives, and the new note's text was landing in that
  guard and being dropped. Nothing wrote it again, so the editor kept showing
  the note before it while the tab, the breadcrumb and the status bar all
  named the one that had been clicked.

  The binding comes down *first and in its own transaction*, before a
  character of the new note is written: while it is up, every change to this
  document is pushed into that room's text (`YSyncPluginValue.update`), so
  replacing the document with a different note would send the note somebody
  else is reading down the wire as an edit of theirs.
*/
export function followNote({
  view,
  shownPath,
  collab,
  bound,
  latestValue,
  notePath,
  value,
}: {
  view: { current: EditorView | null };
  shownPath: { current: string | null };
  collab: { current: Compartment };
  bound: { current: SharedDoc | null };
  latestValue: { current: string };
  notePath: string | null | undefined;
  value: string;
}): void {
  const current = view.current;
  const path = notePath ?? null;
  if (current === null || path === shownPath.current) return;
  shownPath.current = path;
  unbind(current, collab.current);
  bound.current = null;
  latestValue.current = value;
  /*
    Compared rather than written unconditionally, because a path can change
    under a document that is not changing: a note renamed or moved while it
    is open keeps its text and gets a new room, and replacing the document
    there would take the caret out of the middle of the sentence somebody is
    writing.
  */
  if (value !== current.state.doc.toString()) replaceDocument(current, value);
}

/*
  The shared document, into the editor.

  Once this is in, CodeMirror's text *is* the shared text: a keystroke here
  becomes an update that goes to everybody else, and their updates arrive as
  ordinary transactions. The `value` effect below stops being the authority
  for this note, which is why it checks for a binding before replacing
  anything — the two would otherwise fight over the same document and the
  visible symptom would be your own typing disappearing.

  Two things this has to get right, both of which cost a note when they are
  wrong:

  **The old binding is taken down in a transaction of its own.** CodeMirror
  keeps a `ViewPlugin` instance across a reconfiguration that still contains
  that plugin, and `ySync` is one module-level plugin — so swapping
  `yCollab(a)` for `yCollab(b)` in a single dispatch leaves the *same* plugin
  value in place, still holding the `Y.Text` it was constructed with. The
  editor then goes on relaying keystrokes into the room for the note it used
  to be showing, which is how the stale note above survived being noticed:
  every later room was bound in name only.

  **A binding needs a document the room agrees with.** `yCollab` maps editor
  offsets straight onto `Y.Text` offsets, so binding an empty room to a
  document that holds a note means the first keystroke lands at an offset the
  room does not have — and the seed, when it arrives, is an insert at 0 of
  text the editor is already showing, which is the duplicated note
  `sharedDoc.ts` is written to prevent. So a room that already holds the note
  is taken as authoritative and written in, and a room that holds nothing yet
  is waited on rather than bound: the note stays on the glass, `value` stays
  its authority, and the binding goes up the moment the seed or the replay
  gives the two of them the same text.
*/
export function bindSharedDocument({
  view,
  collab,
  bound,
  bindIfWaiting,
  latestValue,
  settledRef,
  presence,
}: {
  view: { current: EditorView | null };
  collab: { current: Compartment };
  bound: { current: SharedDoc | null };
  bindIfWaiting: { current: (() => void) | null };
  latestValue: { current: string };
  settledRef: { current: boolean };
  presence: LiveEditorProps["presence"];
}): (() => void) | undefined {
  const current = view.current;
  const shared = presence?.shared ?? null;
  if (current === null) return;
  unbind(current, collab.current);
  bound.current = null;
  bindIfWaiting.current = null;
  if (shared === null) return;
  /*
    The same object under a name the closures below can keep: a hoisted
    function declaration does not carry the narrowing of the check above, and
    re-testing for null inside each of them would be three ways of saying
    what this line says once.
  */
  const room = shared;

  let waiting = true;
  let watching = false;
  /** Stop listening for the seed, whether or not we ever started. */
  const stopWatching = () => {
    if (!watching) return;
    watching = false;
    room.text.unobserve(onSeeded);
  };
  const bind = () => {
    const live = view.current;
    if (!waiting || live === null) return;
    waiting = false;
    stopWatching();
    bound.current = room;
    const roomText = room.text.toString();
    if (roomText !== live.state.doc.toString()) {
      latestValue.current = roomText;
      replaceDocument(live, roomText);
    }
    live.dispatch({
      // No cast: `SharedDoc.text` is a `Y.Text`, which is exactly what the
      // binding takes. The first version of this typed it as `unknown` and
      // reached for `any` to get past the door, which is a lint error telling
      // the truth — the type was available the whole time.
      effects: [
        collab.current.reconfigure(yCollab(room.text, null)),
        // Carets arrive as positions relative to this document, so the
        // extension needs the document itself to place them.
        setCaretDocument.of(room.doc),
      ],
    });
  };
  /*
    Named rather than inline so `bind` can take it off again: the observer
    is how an empty room says it has been seeded, and it has done its whole
    job the first time it fires.
  */
  function onSeeded() {
    if (room.text.length > 0) bind();
  }

  /*
    **An empty room is not always a room that has not spoken.**

    The rule used to be "bind once the document has text", which is right for
    the hazard it was written against — binding an editor that is showing a
    note to a room that does not hold it yet means the seed arrives as an
    insert at 0 of text already on screen, and the note contains itself twice.

    It is wrong for a note that is **empty**, which is what two people open to
    try this feature out. The seed is the empty string, the document never
    gets text, and the binding never went up: no keystroke of anybody's
    reached the room, `setCaretDocument` was never dispatched so no peer's
    caret could be drawn, and the client that was not elected to save had its
    typing dropped by `mayPersist`. "No carets, and my typing did not sync."

    So the condition is text **or** a room that has said it holds none —
    which `usePresence` reports as `settled`, and which is exactly the fact
    the document alone could not carry. The old hazard is still refused: a
    settled room that is empty under an editor that is *not* keeps waiting,
    because those two disagree and the room losing is how a loaded note gets
    blanked.
  */
  const settledEmptyRoom = () => settledRef.current && current.state.doc.length === 0;

  if (presence?.collaboration?.ready === true || room.text.length > 0 || settledEmptyRoom()) {
    bind();
  } else {
    watching = true;
    room.text.observe(onSeeded);
    /*
      And the same attempt again when the room settles, which arrives as a
      prop rather than as a change to the document. Held in a ref so the
      settle does not tear this effect down and rebuild the binding — see
      the header on why swapping a `yCollab` in place is not safe.
    */
    bindIfWaiting.current = () => {
      if (settledEmptyRoom()) bind();
    };
  }

  return () => {
    waiting = false;
    stopWatching();
    bindIfWaiting.current = null;
  };
}
