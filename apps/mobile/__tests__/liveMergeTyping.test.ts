/**
 * @jest-environment jsdom
 */

/**
 * TWO REAL EDITORS, ONE NOTE, ACTUAL KEYSTROKES.
 *
 * Everything else about this feature is tested below the editor: documents
 * wired to each other, frames run between the two codebases, the room's log
 * replayed. All of it passed while the thing somebody actually reported —
 * *"I didn't see what I was typing"* — was still possible, because that bug
 * lived in the wiring between CodeMirror and the rest, which none of those
 * tests touch.
 *
 * So this mounts the real `LiveEditor` twice, binds both to a shared document
 * the way `usePresence` does, and types. It asserts the two things a person
 * would notice:
 *
 *  1. **Your own letters appear**, which is the reported bug.
 *  2. **Their letters appear too**, which is the feature.
 *
 * It cannot cover the socket, the gateway or the save path — there is no
 * server here. What it covers is the seam those tests cannot reach.
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { LiveEditor } from "../features/console/files/LiveEditor.web";
import { createSharedDoc, mayPersist, seedSharedDoc } from "../features/console/presence/sharedDoc";
import { EditorView } from "@codemirror/view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** One editor, mounted for real, bound to one end of a shared document. */
function editor(options: {
  shared: ReturnType<typeof createSharedDoc>;
  canWrite: boolean;
  value: string;
  /**
   * Whether the room has told this client everything it holds.
   *
   * Defaults to `true` because that is what every case below except the empty
   * note is: the fixture seeds the document before mounting, which is the room
   * having already spoken. The empty-note checks pass it explicitly, because
   * an empty room is the one state where "the room holds nothing" and "the
   * room has not answered yet" look identical from the document alone.
   */
  settled?: boolean;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const changes: string[] = [];

  act(() => {
    root.render(
      createElement(LiveEditor, {
        value: options.value,
        editable: true,
        notePath: "1-projects/shared.md",
        onChange: (text: string) => changes.push(text),
        onSave: () => {},
        accessibilityLabel: "note markdown",
        presence: {
          members: [],
          report: () => {},
          shared: options.shared,
          canWrite: options.canWrite,
          settled: options.settled ?? true,
        },
      }),
    );
  });

  const state = { saves: 0, value: options.value };
  const render = () =>
    act(() => {
      root.render(
        createElement(LiveEditor, {
          value: state.value,
          editable: true,
          notePath: "1-projects/shared.md",
          onChange: (text: string) => changes.push(text),
          onSave: () => {
            state.saves += 1;
          },
          accessibilityLabel: "note markdown",
          presence: {
            members: [],
            report: () => {},
            shared: options.shared,
            canWrite: options.canWrite,
            settled: options.settled ?? true,
          },
        }),
      );
    });

  return {
    changes,
    /** What CodeMirror is actually showing. */
    text: () => container.querySelector(".cm-content")?.textContent ?? "",
    /**
     * Type into this editor the way a person does — through CodeMirror, not
     * into the shared document behind it.
     *
     * The difference is the whole of what the binding is. Inserting into the
     * `Y.Text` directly reaches every peer whether or not this editor was ever
     * wired to it, so a check written that way passes over an editor that is
     * bound to nothing — which is exactly the state the empty-note bug left
     * every client in.
     */
    type: (text: string) => {
      const live = EditorView.findFromDOM(container);
      if (live === null) throw new Error("no editor mounted");
      act(() => {
        live.dispatch({
          changes: { from: live.state.doc.length, insert: text },
          userEvent: "input.type",
        });
      });
    },
    /** The parent re-rendering with whatever draft it is holding. */
    rerender: (next: { value: string }) => {
      state.value = next.value;
      render();
    },
    get saves() {
      return state.saves;
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe("two people typing in one note", () => {
  test("your own letters appear as you type them", () => {
    // The reported bug, stated as a check. If the shared document and the
    // `value` prop ever both claim authority, this is what goes red.
    const shared = createSharedDoc({ onLocalUpdate: () => {} });
    seedSharedDoc(shared, "start");
    const mine = editor({ shared, canWrite: true, value: "start" });

    act(() => {
      shared.text.insert(5, "ing");
    });

    expect(mine.text()).toContain("starting");
    mine.unmount();
  });

  test("their letters appear in your editor, one at a time", () => {
    // Two documents relaying to each other, two real editors bound to them.
    let theirs: ReturnType<typeof createSharedDoc>;
    const yours = createSharedDoc({ onLocalUpdate: (u) => theirs.applyRemote(u) });
    theirs = createSharedDoc({ onLocalUpdate: (u) => yours.applyRemote(u) });

    seedSharedDoc(yours, "hello");
    const yourEditor = editor({ shared: yours, canWrite: true, value: "hello" });
    const theirEditor = editor({ shared: theirs, canWrite: false, value: "hello" });

    for (const letter of " world") {
      act(() => {
        theirs.text.insert(theirs.text.length, letter);
      });
    }

    expect(yourEditor.text()).toContain("hello world");
    expect(theirEditor.text()).toContain("hello world");
    yourEditor.unmount();
    theirEditor.unmount();
  });

  test("a stale `value` does not overwrite the shared document", () => {
    /*
      Review found the guard for this missing: the effect's comment said it
      stands down while a room is bound and there was no condition under it.
      It matters because `value` is the local draft, and for every client
      except the elected writer that draft is stale *by construction* — they
      deliberately stop calling `onChange`. So a re-render would replace
      everybody's text with one client's stale copy.
    */
    let theirs: ReturnType<typeof createSharedDoc>;
    const yours = createSharedDoc({ onLocalUpdate: (u) => theirs.applyRemote(u) });
    theirs = createSharedDoc({ onLocalUpdate: (u) => yours.applyRemote(u) });
    seedSharedDoc(yours, "the shared text");

    const reader = editor({ shared: theirs, canWrite: false, value: "the shared text" });
    act(() => {
      yours.text.insert(15, " plus an edit");
    });
    expect(reader.text()).toContain("the shared text plus an edit");

    // Now the parent re-renders with the draft it still holds, which is what
    // the note looked like before anybody typed.
    act(() => {
      reader.rerender({ value: "the shared text" });
    });
    expect(reader.text()).toContain("the shared text plus an edit");
  });

  test("typing and saving are gated by one predicate, not two conditions", () => {
    /*
      `onChange` was gated and ⌘S was not, so any client in a room could push
      its own draft to the bucket with one keystroke — the racing-writers
      collision the election exists to prevent, through the control that skips
      autosave entirely. Both call sites now ask `mayPersist`.

      Asserted on the predicate rather than by dispatching ⌘S: the save key
      fires from CodeMirror's keymap, and a synthetic keydown does not reach it
      reliably under jsdom. Claiming a keystroke test that is really a stub
      would be worse than saying which half is covered — the change path below
      exercises the same predicate through a real editor.
    */
    expect(mayPersist({ bound: true, canWrite: false })).toBe(false);
    expect(mayPersist({ bound: true, canWrite: true })).toBe(true);
    // No room: a note nobody else is in behaves exactly as it always did.
    expect(mayPersist({ bound: false, canWrite: false })).toBe(true);
    expect(mayPersist(undefined)).toBe(true);
    /*
      **Bound, not merely present.** This asked about `shared` — the document
      object, which `usePresence` creates the moment the hook runs and before
      any socket connects — so a client whose editor was not wired to that
      document at all was still silenced by it. For an empty note the editor
      never got wired, so the answer was "do not persist" forever.
    */
  });

  test("only the elected writer marks the note unsaved", () => {
    // Two savers would race against one etag and conflict with each other —
    // the collision this feature removes, arriving from the other end.
    let theirs: ReturnType<typeof createSharedDoc>;
    const yours = createSharedDoc({ onLocalUpdate: (u) => theirs.applyRemote(u) });
    theirs = createSharedDoc({ onLocalUpdate: (u) => yours.applyRemote(u) });
    seedSharedDoc(yours, "note");

    const writer = editor({ shared: yours, canWrite: true, value: "note" });
    const reader = editor({ shared: theirs, canWrite: false, value: "note" });

    act(() => {
      yours.text.insert(4, "!");
    });

    expect(writer.changes.length).toBeGreaterThan(0);
    expect(reader.changes).toEqual([]);
    // ...and the reader is still showing the text, which is the point: it is
    // not saving, not that it is not participating.
    expect(reader.text()).toContain("note!");
    writer.unmount();
    reader.unmount();
  });
});

/**
 * THE NOTE NOBODY HAD TYPED IN YET.
 *
 * Every check above seeds the document before mounting, so the binding goes up
 * on the first render and the tests are about what happens afterwards. The
 * product does not always produce that shape: two people open a **new, empty**
 * note, which is exactly what somebody does to try this feature out.
 *
 * An empty note seeds to an empty document, so `room.text.length > 0` is never
 * true, so the binding was never installed — and everything hanging off it went
 * with it:
 *
 *  - nobody's keystrokes reached the room, because CodeMirror was never wired
 *    to the shared text;
 *  - no remote caret was drawn, because `setCaretDocument` is dispatched by the
 *    same `bind()`;
 *  - and the client that was not elected to save had its `onChange` dropped by
 *    `mayPersist` — which was asking whether a room *object exists* rather than
 *    whether this editor is actually bound to one — so its typing reached
 *    neither the room nor the bucket. It sat on the glass until the tab closed.
 *
 * "No carets, and my typing did not sync," reported from two browsers, is all
 * three of those at once.
 */
describe("two people in a note that is still empty", () => {
  test("what I type reaches the room, with nothing to seed from", () => {
    /*
      Typed through CodeMirror rather than into the `Y.Text`, which is the only
      version of this check that can fail: an insert into the document behind
      an editor reaches every peer whether or not that editor was ever wired to
      it. Nobody's *keystroke* did, and a note two people had open collected
      one person's typing and threw the other's away.
    */
    let theirs: ReturnType<typeof createSharedDoc>;
    const yours = createSharedDoc({ onLocalUpdate: (u) => theirs.applyRemote(u) });
    theirs = createSharedDoc({ onLocalUpdate: (u) => yours.applyRemote(u) });
    // No `seedSharedDoc`: the note is new, so the seed is the empty string and
    // the room holds nothing. The room has still spoken — that is `settled`.
    const mine = editor({ shared: yours, canWrite: true, value: "", settled: true });

    mine.type("hello");

    expect(theirs.text.toString()).toContain("hello");
    mine.unmount();
  });

  test("...and a peer's letters come back the other way", () => {
    let theirs: ReturnType<typeof createSharedDoc>;
    const yours = createSharedDoc({ onLocalUpdate: (u) => theirs.applyRemote(u) });
    theirs = createSharedDoc({ onLocalUpdate: (u) => yours.applyRemote(u) });
    const mine = editor({ shared: yours, canWrite: true, value: "", settled: true });

    act(() => {
      theirs.text.insert(0, "from them");
    });

    expect(mine.text()).toContain("from them");
    mine.unmount();
  });

  test("the client that is not elected to save still types into the room", () => {
    let theirs: ReturnType<typeof createSharedDoc>;
    const yours = createSharedDoc({ onLocalUpdate: (u) => theirs.applyRemote(u) });
    theirs = createSharedDoc({ onLocalUpdate: (u) => yours.applyRemote(u) });

    const writer = editor({ shared: yours, canWrite: true, value: "", settled: true });
    const reader = editor({ shared: theirs, canWrite: false, value: "", settled: true });

    reader.type("from the reader");

    // The elected writer sees it, which is what "collaboration works" means
    // here: the reader's text reached the room and came back out.
    expect(writer.text()).toContain("from the reader");
    // ...and it is the writer, not the reader, who marks the note unsaved.
    expect(writer.changes.length).toBeGreaterThan(0);
    expect(reader.changes).toEqual([]);
    writer.unmount();
    reader.unmount();
  });

  test("a settled room holding nothing does not blank a note that is loaded", () => {
    /*
      The other half of `settledEmptyRoom`, and the half a sabotage sweep found
      nothing checking.

      "Settled" is the room's answer about itself, and binding on it alone would
      trust it against the evidence: an editor showing a note, over a room that
      says it holds none, is two parties disagreeing — and `bind()` resolves a
      disagreement by making the room win, which here means replacing the
      customer's note with an empty document and then saving that.

      So the two are required together. A room with text binds on the text; a
      room with none binds only over an editor that also has none, which is the
      new note this whole block is about.
    */
    const shared = createSharedDoc({ onLocalUpdate: () => {} });
    const mine = editor({ shared, canWrite: true, value: "a loaded note", settled: true });

    expect(mine.text()).toContain("a loaded note");
    // Unbound, so `value` is still the authority — which is what the editor
    // did before any of this existed, and the correct behaviour for a room
    // that cannot be reconciled with what is on screen.
    act(() => {
      mine.rerender({ value: "a loaded note, edited elsewhere" });
    });
    expect(mine.text()).toContain("a loaded note, edited elsewhere");
    mine.unmount();
  });

  test("the room has not answered yet, so the note on the glass is still the note", () => {
    /*
      The other half of the same seam, and the reason `settled` is a signal from
      the room rather than "is the document empty".

      Before the room answers, an empty shared document is indistinguishable
      from a room that holds nothing — so binding on emptiness alone would bind
      to a document the room is about to replace, and the seed arriving a moment
      later would insert the note a second time. So while the room is silent the
      `value` prop stays the authority, exactly as it was before any of this
      existed.
    */
    const shared = createSharedDoc({ onLocalUpdate: () => {} });
    const mine = editor({ shared, canWrite: true, value: "", settled: false });

    act(() => {
      mine.rerender({ value: "the note, arriving from the bucket" });
    });

    expect(mine.text()).toContain("the note, arriving from the bucket");
    mine.unmount();
  });
});
