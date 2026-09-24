/**
 * The editor's state: unsaved changes, saving, and a conflict that never
 * silently clobbers in either direction.
 *
 * Split out of `fileEditor.test.ts`; see `fixtures.ts` in this folder.
 */

import { describe, expect, test } from "@jest/globals";
import {
  editorReducer,
  emptyEditor,
  guardLeaving,
  isDirty,
  saveButton,
  type EditorState,
} from "../../features/console/files/editor";
import { NOTE, opened } from "./fixtures";

describe("unsaved changes", () => {
  test("a freshly opened note is clean", () => {
    const state = opened();
    expect(state.status).toBe("clean");
    expect(isDirty(state)).toBe(false);
    expect(guardLeaving(state).allowed).toBe(true);
  });

  test("typing makes it dirty, and no longer blocks navigation", () => {
    /*
      This asserted the opposite until autosave: an unsaved draft refused to
      let anybody open another note, because the single editor slot would have
      thrown it away. It is written on the way out now (`select` flushes), so
      the refusal was a prompt in front of a problem that no longer exists —
      which is the "bugging people to save" the change is about.

      The two states that still refuse are `conflict` and `error`; see
      `autosave.test.ts`, which owns that policy.
    */
    const state = editorReducer(opened(), { type: "edited", text: "# A\n\nmore" });
    expect(state.status).toBe("dirty");
    expect(isDirty(state)).toBe(true);
    expect(guardLeaving(state)).toEqual({ allowed: true });
  });

  test("typing back to the original text is not a change", () => {
    let state = editorReducer(opened(), { type: "edited", text: "# B\n" });
    state = editorReducer(state, { type: "edited", text: "# A\n" });
    expect(state.status).toBe("clean");
    expect(isDirty(state)).toBe(false);
  });

  test("discarding restores what the server has", () => {
    let state = editorReducer(opened(), { type: "edited", text: "# B\n" });
    state = editorReducer(state, { type: "discarded" });
    expect(state.draft).toBe("# A\n");
    expect(isDirty(state)).toBe(false);
  });

  test("a read-only note cannot be edited at all", () => {
    const manifest = editorReducer(emptyEditor, {
      type: "opened",
      note: { ...NOTE, path: "privacy.md", readOnly: true },
    });
    const after = editorReducer(manifest, { type: "edited", text: "everything: team" });
    expect(after.draft).toBe(NOTE.text);
    expect(saveButton(after)).toEqual({ label: "Read-only", disabled: true });
  });
});

describe("saving", () => {
  test("a successful save makes the draft the new baseline", () => {
    let state = editorReducer(opened(), { type: "edited", text: "# B\n" });
    state = editorReducer(state, { type: "saveStarted" });
    expect(saveButton(state)).toEqual({ label: "Saving…", disabled: true });
    state = editorReducer(state, {
      type: "saveSucceeded",
      etag: "e2",
      conflictCheck: "conditional",
    });
    expect(state.status).toBe("saved");
    expect(state.etag).toBe("e2");
    expect(isDirty(state)).toBe(false);
    expect(state.message).toBe("Saved.");
  });

  /**
   * B2 and Wasabi accept `If-Match` and write anyway. The probe already caught
   * that at connect time; the editor's job is not to pretend otherwise.
   */
  test("a bucket without conditional writes is told the truth about it", () => {
    let state = editorReducer(opened(), { type: "edited", text: "# B\n" });
    state = editorReducer(state, {
      type: "saveSucceeded",
      etag: "e2",
      conflictCheck: "read-compare",
    });
    expect(state.message).toMatch(/best-effort/);
  });

  test("an ordinary failure keeps the draft and says why", () => {
    let state = editorReducer(opened(), { type: "edited", text: "# B\n" });
    state = editorReducer(state, {
      type: "saveFailed",
      error: { code: "STORAGE_FAILED", message: "Your bucket did not complete that request." },
    });
    expect(state.status).toBe("error");
    expect(state.draft).toBe("# B\n");
    expect(state.message).toMatch(/did not complete/);
    expect(saveButton(state).disabled).toBe(false);
  });
});

describe("a conflict never silently clobbers, in either direction", () => {
  function conflicted(): EditorState {
    let state = editorReducer(opened(), { type: "edited", text: "# Mine\n" });
    state = editorReducer(state, { type: "saveStarted" });
    return editorReducer(state, {
      type: "saveFailed",
      error: {
        code: "CONFLICT",
        message: "That file changed somewhere else while you were editing it.",
        currentEtag: "e9",
      },
    });
  }

  test("the draft survives — losing what somebody typed is the worst outcome here", () => {
    const state = conflicted();
    expect(state.status).toBe("conflict");
    expect(state.draft).toBe("# Mine\n");
    expect(state.message).toMatch(/changed somewhere else/);
    expect(state.conflictEtag).toBe("e9");
  });

  test("typing more does not clear the conflict", () => {
    const state = editorReducer(conflicted(), { type: "edited", text: "# Mine, more\n" });
    expect(state.status).toBe("conflict");
    expect(state.conflictEtag).toBe("e9");
  });

  test("the save button says plainly what pressing it would do", () => {
    expect(saveButton(conflicted())).toEqual({ label: "Overwrite theirs", disabled: false });
  });

  test("choosing theirs replaces the draft and clears the conflict", () => {
    const state = editorReducer(conflicted(), {
      type: "reloaded",
      note: { ...NOTE, text: "# Theirs\n", etag: "e9" },
    });
    expect(state.status).toBe("clean");
    expect(state.draft).toBe("# Theirs\n");
    expect(state.conflictEtag).toBeUndefined();
  });

  /**
   * Choosing "keep mine" rebases onto the etag that is actually current — so
   * the next save is still a conditional write, against a version the person
   * has been shown. It is an override, not a switch that turns the check off.
   */
  test("choosing yours rebases onto the current etag rather than disabling the check", () => {
    const state = editorReducer(conflicted(), { type: "conflictOverridden" });
    expect(state.status).toBe("dirty");
    expect(state.etag).toBe("e9");
    expect(state.draft).toBe("# Mine\n");
    expect(state.conflictEtag).toBeUndefined();
  });
});
