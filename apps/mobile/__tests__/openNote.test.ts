import { afterEach, describe, expect, test } from "@jest/globals";
import {
  openNoteSnapshot,
  publishOpenNote,
  resetOpenNote,
  subscribeToOpenNote,
} from "../features/agent/openNote";
import type { NoteReference } from "../features/agent/page";

/**
 * THE NOTE ON SCREEN, PUBLISHED ONCE AND READ BESIDE IT.
 *
 * The editor is the only thing that can build a `NoteReference` — `page.ts`
 * argues that where `noteReference` is defined — and the console's right panel
 * is its sibling rather than its ancestor. This is the channel between them,
 * and it has two jobs it can get wrong:
 *
 *  1. **It must not notify on every keystroke.** `NoteEditor` rebuilds the
 *     reference on every render, so a store comparing by identity would
 *     re-render the whole panel — and the conversation inside it — on each
 *     character typed;
 *  2. **it must notify when a field that matters changes**, and `unsaved` is
 *     the one that matters most: it is what tells the model the saved text may
 *     be behind the screen, and a store that missed it would leave that claim
 *     stale in exactly the situation it exists for.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `same` comparing by identity (`a === b`).
 *     → **2 fail**: `an unchanged note notifies nobody` and `the same note
 *     read twice is the same object`. Every render of the editor would wake
 *     the panel.
 *  2. `same` dropping its `unsaved` term.
 *     → **3 fail**: `typing into the open note is a change`, `every field that
 *     can change is one the store notices`, and `a listener is told when it
 *     changes and not when it does not`.
 *  3. `openNoteSnapshot` returning `{ ...current }`.
 *     → **2 fail**: `the same note read twice is the same object` and `an
 *     unchanged note notifies nobody` — the second because identity is how
 *     "unchanged" is observed at all. React
 *     compares snapshots by identity and loops forever on a getter that
 *     allocates — a failure that only appears inside a render, which is why
 *     this is asserted here rather than left to show up at runtime.
 */

const NOTE: NoteReference = {
  path: "1-projects/pricing.md",
  etag: "abc123",
  visibility: "team",
  readable: true,
  unsaved: false,
};

afterEach(resetOpenNote);

describe("the channel between the editor and the panel", () => {
  test("a note published is the note read back", () => {
    publishOpenNote(NOTE);
    expect(openNoteSnapshot()).toEqual(NOTE);
  });

  test("a folder, or nothing open, is null", () => {
    publishOpenNote(NOTE);
    publishOpenNote(null);
    expect(openNoteSnapshot()).toBeNull();
  });

  test("the same note read twice is the same object", () => {
    publishOpenNote(NOTE);
    expect(openNoteSnapshot()).toBe(openNoteSnapshot());
  });

  test("an unchanged note notifies nobody", () => {
    publishOpenNote(NOTE);
    const first = openNoteSnapshot();

    // The editor re-rendering: a fresh object, every field equal.
    publishOpenNote({ ...NOTE });

    // The same object back, so React re-renders nothing.
    expect(openNoteSnapshot()).toBe(first);
  });

  test("a listener is told when it changes and not when it does not", () => {
    let woken = 0;
    const stop = subscribeToOpenNote(() => {
      woken += 1;
    });

    publishOpenNote(NOTE);
    expect(woken).toBe(1);

    publishOpenNote({ ...NOTE });
    expect(woken).toBe(1);

    publishOpenNote({ ...NOTE, unsaved: true });
    expect(woken).toBe(2);

    stop();
    publishOpenNote(null);
    expect(woken).toBe(2);
  });

  test("typing into the open note is a change", () => {
    publishOpenNote(NOTE);
    const first = openNoteSnapshot();

    publishOpenNote({ ...NOTE, unsaved: true });

    expect(openNoteSnapshot()).not.toBe(first);
    expect(openNoteSnapshot()?.unsaved).toBe(true);
  });

  test("every field that can change is one the store notices", () => {
    const changes: NoteReference[] = [
      { ...NOTE, path: "2-areas/other.md" },
      { ...NOTE, etag: "def456" },
      { ...NOTE, visibility: "private" },
      { ...NOTE, readable: false },
      { ...NOTE, unsaved: true },
    ];
    for (const change of changes) {
      publishOpenNote(NOTE);
      const before = openNoteSnapshot();
      publishOpenNote(change);
      expect(openNoteSnapshot() === before).toBe(false);
    }
  });

  /**
   * The shape is `page.ts`'s, and `agentPage.test.ts` searches it for a
   * sentinel planted in the note's text. Restated here as the field list, so
   * a widening of `NoteReference` to carry a body has to be a diff in two
   * files rather than one.
   */
  test("there is no field a body could travel in", () => {
    publishOpenNote(NOTE);
    expect(Object.keys(openNoteSnapshot() ?? {}).sort()).toEqual([
      "etag",
      "path",
      "readable",
      "unsaved",
      "visibility",
    ]);
  });
});
