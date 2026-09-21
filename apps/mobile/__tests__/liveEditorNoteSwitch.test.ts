/**
 * @jest-environment jsdom
 */

/**
 * OPENING A DIFFERENT NOTE, WITH A ROOM ALREADY BOUND.
 *
 * The reported bug, in the person's own words: *"whatever I'm selecting on the
 * left is not the content that shows up in the middle."* The breadcrumb, the
 * tab and the status bar all named the note that was clicked; the text on the
 * glass was the note before it.
 *
 * It is a seam, which is why nothing else caught it. `usePresence` creates the
 * shared document for a note whether or not the socket ever opens, and the
 * effect that writes an authoritative `value` into CodeMirror stands down while
 * a shared document is bound — correctly, because in a live room the room is
 * the authority and the local draft is stale by construction. But opening a
 * *different* note arrives at the editor one commit before the room for it
 * does: `value` and `notePath` change together, the child's effects run before
 * the parent's, and `presence.shared` is still the room for the note being
 * left. So the new note's text met a guard written about the old note's room
 * and was dropped, and nothing wrote it again.
 *
 * The order below is that order, exactly: a render with the new note and the
 * old room, then the room for the new note. What these assert is what a person
 * sees — the text of the note they clicked — plus the thing they must never
 * see, which is their note being carried into the room they just left.
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { LiveEditor } from "../features/console/files/LiveEditor.web";
import { createSharedDoc, seedSharedDoc } from "../features/console/presence/sharedDoc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Shared = ReturnType<typeof createSharedDoc>;

const ALPHA = "# Alpha\n\nthe first note";
const BETA = "# Beta\n\nthe second note";

/** One console, holding one note open, with whatever room it has been given. */
function console_(first: { value: string; notePath: string; shared: Shared | null }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const state = { ...first };

  const render = () =>
    act(() => {
      root.render(
        createElement(LiveEditor, {
          value: state.value,
          editable: true,
          notePath: state.notePath,
          onChange: () => {},
          onSave: () => {},
          accessibilityLabel: "note markdown",
          presence: {
            members: [],
            report: () => {},
            shared: state.shared,
            canWrite: true,
          },
        }),
      );
    });

  render();

  return {
    text: () => container.querySelector(".cm-content")?.textContent ?? "",
    /** The live editor, through CodeMirror's own public lookup. */
    view: () => {
      const dom = container.querySelector(".cm-editor");
      const live = dom === null ? null : EditorView.findFromDOM(dom as HTMLElement);
      if (live === null) throw new Error("no EditorView mounted");
      return live;
    },
    /** A re-render with whatever the parent now holds — a note, a room, both. */
    show: (next: Partial<{ value: string; notePath: string; shared: Shared | null }>) => {
      Object.assign(state, next);
      render();
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe("opening a different note while a room is bound", () => {
  test("the note that was clicked is the note on the glass", () => {
    const roomA = createSharedDoc({ onLocalUpdate: () => {} });
    seedSharedDoc(roomA, ALPHA);
    const screen = console_({ value: ALPHA, notePath: "features/alpha.md", shared: roomA });
    expect(screen.text()).toContain("the first note");

    // The commit the bug lives in: the new note, the old note's room.
    screen.show({ value: BETA, notePath: "features/beta.md" });
    // And the room for it, one commit later, as `usePresence` produces it.
    const roomB = createSharedDoc({ onLocalUpdate: () => {} });
    screen.show({ shared: roomB });

    expect(screen.text()).toContain("the second note");
    expect(screen.text()).not.toContain("the first note");
    screen.unmount();
  });

  test("the note you left keeps its own text in its own room", () => {
    /*
      The other half, and the one that would be a data loss rather than a
      confusion: writing the new note into the editor while the old note's
      room is still bound pushes it down that room's wire, and everybody still
      reading the old note watches it turn into a note they did not open.
    */
    const roomA = createSharedDoc({ onLocalUpdate: () => {} });
    seedSharedDoc(roomA, ALPHA);
    const screen = console_({ value: ALPHA, notePath: "features/alpha.md", shared: roomA });

    screen.show({ value: BETA, notePath: "features/beta.md" });
    const roomB = createSharedDoc({ onLocalUpdate: () => {} });
    screen.show({ shared: roomB });

    expect(roomA.markdown()).toBe(ALPHA);
    screen.unmount();
  });

  test("a room that already holds the note is what the editor shows", () => {
    // Somebody else was in the new note first, so the room has its text and is
    // the authority for it — including any edit made since the bucket read.
    const roomA = createSharedDoc({ onLocalUpdate: () => {} });
    seedSharedDoc(roomA, ALPHA);
    const screen = console_({ value: ALPHA, notePath: "features/alpha.md", shared: roomA });

    const roomB = createSharedDoc({ onLocalUpdate: () => {} });
    seedSharedDoc(roomB, `${BETA}, and a word they typed`);
    screen.show({ value: BETA, notePath: "features/beta.md" });
    screen.show({ shared: roomB });

    expect(screen.text()).toContain("the second note, and a word they typed");
    expect(screen.text()).not.toContain("the first note");
    screen.unmount();
  });

  test("the seed arriving after the switch does not write the note twice", () => {
    /*
      The room is seeded by whichever client arrives to it empty, and the seed
      comes back through the binding as an ordinary insert. If the editor is
      already showing the note when that lands, the person watches their note
      appear a second time above itself — the duplication `sharedDoc.ts` is
      written around, arriving from the one direction it did not cover.
    */
    const roomA = createSharedDoc({ onLocalUpdate: () => {} });
    seedSharedDoc(roomA, ALPHA);
    const screen = console_({ value: ALPHA, notePath: "features/alpha.md", shared: roomA });

    screen.show({ value: BETA, notePath: "features/beta.md" });
    const roomB = createSharedDoc({ onLocalUpdate: () => {} });
    screen.show({ shared: roomB });
    act(() => {
      seedSharedDoc(roomB, BETA);
    });

    expect(screen.text()).toContain("the second note");
    expect(screen.text()?.match(/the second note/g) ?? []).toHaveLength(1);
    screen.unmount();
  });

  test("renaming the open note leaves the caret where the writing is", () => {
    /*
      A path can change under a document that is not changing. A rename or a
      move keeps the text and gets a new room, so the switch above fires — and
      a document written back unconditionally there would take the caret out of
      the middle of the sentence somebody is in the act of typing, which is the
      bug this whole file is about wearing different clothes.
    */
    const room = createSharedDoc({ onLocalUpdate: () => {} });
    seedSharedDoc(room, ALPHA);
    const screen = console_({ value: ALPHA, notePath: "features/alpha.md", shared: room });
    act(() => {
      screen.view().dispatch({ selection: { anchor: 12 } });
    });

    screen.show({ notePath: "3-resources/alpha.md" });
    expect(screen.view().state.selection.main.head).toBe(12);
    expect(screen.text()).toContain("the first note");
    screen.unmount();
  });

  test("a room re-created for the same note is bound for real, not in name", () => {
    /*
      The same note, a second room: a reconnect, a re-auth, an endpoint that
      moved — `usePresence` builds a new document each time and hands it down,
      with `notePath` never changing.

      This is the check that the binding is *replaced* rather than reconfigured
      around. `ySync` is one module-level `ViewPlugin`, and CodeMirror keeps a
      plugin's value across a reconfiguration that still contains that plugin —
      so swapping the extension in a single dispatch leaves the old plugin in
      place, holding the `Y.Text` it was constructed with. Everything looks
      bound and nothing is: the new room's text never arrives, and every
      keystroke goes on being relayed into a room nobody is in.
    */
    const first = createSharedDoc({ onLocalUpdate: () => {} });
    seedSharedDoc(first, ALPHA);
    const screen = console_({ value: ALPHA, notePath: "features/alpha.md", shared: first });

    const second = createSharedDoc({ onLocalUpdate: () => {} });
    seedSharedDoc(second, `${ALPHA}, rejoined`);
    screen.show({ shared: second });
    expect(screen.text()).toContain("the first note, rejoined");

    act(() => {
      second.text.insert(second.text.length, "!");
    });
    expect(screen.text()).toContain("the first note, rejoined!");
    expect(first.markdown()).toBe(ALPHA);
    screen.unmount();
  });

  test("a keystroke after the switch reaches the new note's room, not the old one", () => {
    // What binding is *for*, checked on the far side of a switch: the editor
    // and the room it is now in have to be the same document, or the first
    // letter typed lands at an offset the room does not have.
    const roomA = createSharedDoc({ onLocalUpdate: () => {} });
    seedSharedDoc(roomA, ALPHA);
    const screen = console_({ value: ALPHA, notePath: "features/alpha.md", shared: roomA });

    screen.show({ value: BETA, notePath: "features/beta.md" });
    const roomB = createSharedDoc({ onLocalUpdate: () => {} });
    screen.show({ shared: roomB });
    act(() => {
      seedSharedDoc(roomB, BETA);
    });
    act(() => {
      roomB.text.insert(roomB.text.length, "!");
    });

    expect(screen.text()).toContain("the second note!");
    expect(roomA.markdown()).toBe(ALPHA);
    screen.unmount();
  });
});
