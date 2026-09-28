/**
 * What the side peek edits a note through: the console's one editor, lent
 * to it (`FileBrowser.openBeside`, `fileBrowser/useBesideNote.ts`), and the
 * collaboration room that follows that editor (`useNoteRoom`).
 *
 * Decided by the owner on 2026-09-28, reversing the read-only peek of the
 * same day: "the side panel shouldnt be read only, it should be editable".
 * What made read-only the safe answer was a *second* editor — a writer of the
 * file outside the draft, the autosave, the unsaved-changes guard, the
 * conflict and the room. This is not a second editor: the peek draws the
 * first one's note, and every keystroke goes where a keystroke on the note's
 * own page goes. See `docs/decisions/side-panel.md`.
 */

import type { EditorState } from "../../editor";
import type { Presence } from "../../../presence/usePresence";

export interface PeekEditing {
  /** Put the note in the editor, beside the page; false when the unsaved-changes guard refused. */
  open(path: string): boolean;
  /** Take it out again as the peek closes or moves on (the autosave flushed, the guard asked). */
  close(path: string): boolean;
  /** The editor's note, as the console holds it. */
  readonly editor: Pick<EditorState, "path" | "draft" | "status" | "readOnly" | "encrypted">;
  /** Whether this console may write at all (`FileBrowser.canEdit`): false for a member. */
  readonly canEdit: boolean;
  /** The live room for the editor's note, when there is one: shared typing, carets and saving. */
  readonly presence?: Presence;
  /** A keystroke without a room: the editor's own draft (`FileBrowser.setDraft`). */
  onChange(text: string): void;
  /** ⌘S. */
  onSave(): void;
  /** Where an image in the note is read from, as on its page. */
  onLoadImage?: (target: string) => Promise<string | null>;
}

/** Whether the peek should draw `path` from the editor: it holds that note, and it is one a person may type in. */
export function editsHere(editing: PeekEditing | undefined, path: string | null): editing is PeekEditing {
  return (
    editing !== undefined &&
    path !== null &&
    editing.canEdit &&
    editing.editor.path === path &&
    !editing.editor.readOnly &&
    !editing.editor.encrypted
  );
}
