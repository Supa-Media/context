/**
 * The base a rebuilt collaboration controller replays the editor's draft
 * against.
 *
 * Reported 2026-09-30: a note typed in the browser came back as its text
 * followed by interleaved copies of itself. The durable controller is rebuilt
 * whenever its inputs change (a refreshed console grant is enough), and one
 * with no record on this device sends the editor's unsaved draft as a
 * whole-text replacement. That draft was sent against `etag`, which only moves
 * once nothing is pending, so during continuous typing it was still the
 * version the note was opened at, and everything typed since then was
 * inserted again beside itself.
 */

import { describe, expect, test } from "@jest/globals";
import { editorReducer, type EditorState } from "../../features/console/files/editor";
import { legacyDraftFor } from "../../features/console/collaboration/legacyDraft";
import { NOTE, opened } from "./fixtures";

const OPENED_AT = "c2.doc.r3";

function typing(acknowledged: string[]) {
  let state: EditorState = { ...opened(), etag: OPENED_AT };
  let text = state.draft;
  for (const etag of acknowledged) {
    text += "typed ";
    state = editorReducer(state, { type: "collaboration", text, etag, status: "syncing", pending: 1 });
  }
  return state;
}

describe("replaying a draft after the controller is rebuilt", () => {
  test("uses the newest acknowledged revision, not the version the note was opened at", () => {
    const state = typing(["c2.doc.r4", "c2.doc.r5", "c2.doc.r6"]);
    // Still typing, so nothing was ever fully saved and `etag` never moved.
    expect(state.etag).toBe(OPENED_AT);
    expect(legacyDraftFor(state)?.baseEtag).toBe("c2.doc.r6");
  });

  test("a draft typed before any acknowledgement keeps the base it was typed against", () => {
    const state = editorReducer({ ...opened(), etag: OPENED_AT }, { type: "edited", text: "# A\n\nmore" });
    expect(legacyDraftFor(state)?.baseEtag).toBe(OPENED_AT);
  });

  test("a legacy etag from a plain save is not taken as a collaboration revision", () => {
    let state = typing(["c2.doc.r4"]);
    state = editorReducer(state, { type: "collaboration", text: `${state.draft}more`, etag: "\"plain\"", status: "syncing", pending: 1 });
    expect(legacyDraftFor(state)?.baseEtag).toBe("c2.doc.r4");
  });

  test("nothing is replayed when the draft is what the bucket holds", () => {
    expect(legacyDraftFor(opened())).toBeUndefined();
  });

  test("opening another note forgets the previous note's revision", () => {
    const state = editorReducer(typing(["c2.doc.r4"]), { type: "opened", note: { ...NOTE, path: "1-projects/b.md" } });
    expect(state.collaborationEtag).toBeUndefined();
  });
});
