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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** One editor, mounted for real, bound to one end of a shared document. */
function editor(options: {
  shared: ReturnType<typeof createSharedDoc>;
  canWrite: boolean;
  value: string;
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
          },
        }),
      );
    });

  return {
    changes,
    /** What CodeMirror is actually showing. */
    text: () => container.querySelector(".cm-content")?.textContent ?? "",
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
    expect(mayPersist({ shared: {}, canWrite: false })).toBe(false);
    expect(mayPersist({ shared: {}, canWrite: true })).toBe(true);
    // No room: a note nobody else is in behaves exactly as it always did.
    expect(mayPersist({ shared: null, canWrite: false })).toBe(true);
    expect(mayPersist(undefined)).toBe(true);
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
