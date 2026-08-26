/**
 * The note editor's state machine.
 *
 * Plain markdown in a textarea — not a WYSIWYG. What is worth being careful
 * about is not the typing, it is the two moments either side of it:
 *
 *  - **Unsaved changes.** Clicking another note with an unsaved draft must not
 *    throw the draft away. `guardLeaving` answers "can I navigate?" and the
 *    pane asks it before every selection change.
 *  - **Conflicts.** The bucket is also open in Obsidian and being written by
 *    AI clients, so "somebody else saved while you were typing" is the normal
 *    case, not an edge case. On a conflict the draft is **kept**, the editor
 *    says what happened, and the person chooses: reload theirs and lose yours,
 *    or overwrite theirs. There is no automatic resolution and no silent
 *    clobber in either direction.
 *
 * A reducer rather than a pile of `useState`s, because the interesting
 * transitions — a conflict arriving while the person has already typed more, a
 * second save starting before the first resolved — are exactly the ones that
 * are untestable inside a component and trivial to test here. The console's
 * Jest suite runs in plain node with no renderer.
 */

import type { ConflictCheck, FileError, OpenNote } from "./types";

export type EditorStatus =
  /** Nothing open. */
  | "empty"
  /** Open, unchanged since it was loaded. */
  | "clean"
  /** Open with unsaved changes. */
  | "dirty"
  | "saving"
  /** Saved just now. Decays back to `clean` in the UI. */
  | "saved"
  /** Somebody else wrote it while this draft was open. */
  | "conflict"
  /** The save failed for some other reason; the draft is intact. */
  | "error";

export interface EditorState {
  status: EditorStatus;
  path: string | null;
  /** The text as last known on the server. What "unchanged" compares against. */
  baseline: string;
  /** What is in the textarea. */
  draft: string;
  /** The etag the draft was based on. `null` for a note that does not exist yet. */
  etag: string | null;
  /** `privacy.md` — shown, explained, never typed into. */
  readOnly: boolean;
  /** Copy for the status line. */
  message?: string;
  /** On a conflict: the etag that is actually current, so a save can be forced. */
  conflictEtag?: string;
  /** How the last successful save checked for conflicts. */
  conflictCheck?: ConflictCheck;
}

export const emptyEditor: EditorState = {
  status: "empty",
  path: null,
  baseline: "",
  draft: "",
  etag: null,
  readOnly: false,
};

export type EditorAction =
  | { type: "opened"; note: OpenNote }
  | { type: "closed" }
  | { type: "edited"; text: string }
  | { type: "saveStarted" }
  | { type: "saveSucceeded"; etag: string; conflictCheck: ConflictCheck }
  | { type: "saveFailed"; error: FileError }
  /** The person chose "use theirs" after a conflict. */
  | { type: "reloaded"; note: OpenNote }
  /** The person chose "keep mine" — rebase the draft onto the current etag. */
  | { type: "conflictOverridden" }
  | { type: "discarded" };

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "opened":
    case "reloaded":
      return {
        status: "clean",
        path: action.note.path,
        baseline: action.note.text,
        draft: action.note.text,
        etag: action.note.etag,
        readOnly: action.note.readOnly,
      };

    case "closed":
      return emptyEditor;

    case "edited": {
      if (state.readOnly || state.path === null) return state;
      // A conflict is not cleared by typing. The draft is still based on an
      // etag somebody else has moved past, and pretending otherwise would let
      // the next save silently overwrite them.
      const status =
        state.status === "conflict"
          ? "conflict"
          : action.text === state.baseline
            ? "clean"
            : "dirty";
      return { ...state, draft: action.text, status, message: undefined };
    }

    case "saveStarted":
      return { ...state, status: "saving", message: undefined };

    case "saveSucceeded":
      return {
        ...state,
        status: "saved",
        // The draft is now what the server holds, so "unchanged" means this.
        baseline: state.draft,
        etag: action.etag,
        conflictCheck: action.conflictCheck,
        conflictEtag: undefined,
        message:
          action.conflictCheck === "read-compare"
            ? "Saved. This bucket does not enforce conditional writes, so conflict detection is best-effort."
            : "Saved.",
      };

    case "saveFailed":
      if (action.error.code === "CONFLICT") {
        return {
          ...state,
          status: "conflict",
          // The draft is deliberately untouched. Losing what somebody just
          // typed because somebody else saved first is the worst outcome
          // available here.
          conflictEtag: action.error.currentEtag,
          message: action.error.message,
        };
      }
      return { ...state, status: "error", message: action.error.message };

    case "conflictOverridden":
      // Move onto the etag that is actually current. The next save is then an
      // ordinary conditional write against the version they chose to replace —
      // still conflict-checked, just against a version they have been shown.
      return {
        ...state,
        status: "dirty",
        etag: state.conflictEtag ?? state.etag,
        conflictEtag: undefined,
        message: undefined,
      };

    case "discarded":
      return {
        ...state,
        status: "clean",
        draft: state.baseline,
        conflictEtag: undefined,
        message: undefined,
      };
  }
}

/** Unsaved work exists. */
export function isDirty(state: EditorState): boolean {
  return state.path !== null && !state.readOnly && state.draft !== state.baseline;
}

/**
 * May the person navigate away, and if not, what should they be asked?
 *
 * Returned rather than thrown so the caller decides between a dialog and a
 * quiet refusal — and so the wording is pinned by a test instead of living
 * inside a component nobody renders in CI.
 */
export function guardLeaving(state: EditorState): { allowed: boolean; prompt?: string } {
  if (!isDirty(state)) return { allowed: true };
  return {
    allowed: false,
    prompt: `${state.path} has unsaved changes. Save them, or discard them, before opening something else.`,
  };
}

/** What the save button should say and whether it should be pressable. */
export function saveButton(state: EditorState): { label: string; disabled: boolean } {
  if (state.readOnly) return { label: "Read-only", disabled: true };
  switch (state.status) {
    case "saving":
      return { label: "Saving…", disabled: true };
    case "conflict":
      return { label: "Overwrite theirs", disabled: false };
    case "dirty":
    case "error":
      return { label: "Save", disabled: false };
    default:
      return { label: "Save", disabled: true };
  }
}
