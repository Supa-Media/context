import { useCallback, useEffect, useReducer, useRef } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";

import { createAutosaveController, type AutosaveController } from "../files/autosave";
import { toFileError } from "../files/browser/errors";
import { editorReducer, emptyEditor, type EditorState } from "../files/editor";

/** What `SharedNoteShown` draws an editable grant with: the editor's state and its five answers. */
export interface GrantEditing {
  state: EditorState;
  onChange: (text: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onUseTheirs: () => void;
  onKeepMine: () => void;
}

/** A granted note as `shares.readGrantedNote` answers it, for someone who may edit it. */
export interface EditableNote {
  path: string;
  text: string;
  etag: string;
}

/** The note as the editor opens it: a grant has no visibility of its own to show, so it reads as the workspace's. */
function opened(note: EditableNote) {
  return {
    path: note.path,
    text: note.text,
    etag: note.etag,
    visibility: "team" as const,
    inherited: "team" as const,
    exception: false,
    readOnly: false,
  };
}

/**
 * The editor behind a note an outsider may edit (`shares.writeGrantedNote`).
 *
 * The same reducer and the same autosave timers every note in the app uses, so
 * typing, ⌘S, a failed save and a conflict behave exactly as they do in the
 * person's own workspace. What differs is only where a save goes: one
 * conditional write of the whole body over the version read, through the
 * grant. `null` until `note` arrives, and for a note that is read only.
 */
export function useGrantEditor(workspaceId: string, note: EditableNote | null): GrantEditing | null {
  const write = useAction(api.functions.shares.writeGrantedNote);
  const read = useAction(api.functions.shares.readGrantedNote);
  const [state, dispatch] = useReducer(editorReducer, emptyEditor);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (note !== null) dispatch({ type: "opened", note: opened(note) });
  }, [note]);

  const save = useCallback((over?: string) => {
    const current = stateRef.current;
    const etag = over ?? current.etag;
    if (current.path === null || etag === null) return;
    const path = current.path;
    dispatch({ type: "saveStarted" });
    write({
      workspaceId: workspaceId as Id<"workspaces">,
      path,
      text: current.draft,
      expectedEtag: etag,
    })
      .then((written) => {
        // A save for a note that has since been closed or reopened must not move the new one's baseline.
        if (stateRef.current.path !== path) return;
        dispatch({ type: "saveSucceeded", etag: written.etag, conflictCheck: written.conflictCheck });
      })
      .catch((error: unknown) => {
        if (stateRef.current.path !== path) return;
        dispatch({ type: "saveFailed", error: toFileError(error) });
      });
  }, [write, workspaceId]);

  const autosaveRef = useRef<AutosaveController | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const controller = createAutosaveController<ReturnType<typeof setTimeout>>({
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (handle) => clearTimeout(handle),
      save: () => saveRef.current(),
    });
    autosaveRef.current = controller;
    return () => {
      // Leaving the note hands a pending draft over rather than dropping it.
      controller.flush();
      controller.dispose();
    };
  }, []);

  const onChange = useCallback((text: string) => {
    dispatch({ type: "edited", text });
    const path = stateRef.current.path;
    if (path !== null) autosaveRef.current?.edited(path);
  }, []);

  const onSave = useCallback(() => {
    autosaveRef.current?.cancel();
    save();
  }, [save]);

  const onDiscard = useCallback(() => {
    autosaveRef.current?.cancel();
    dispatch({ type: "discarded" });
  }, []);

  // Their version: read the note again through the grant and drop the draft.
  const onUseTheirs = useCallback(() => {
    const path = stateRef.current.path;
    if (path === null) return;
    autosaveRef.current?.cancel();
    read({ workspaceId: workspaceId as Id<"workspaces">, path })
      .then((fresh) => {
        if (fresh.etag !== null) dispatch({ type: "reloaded", note: opened({ path: fresh.path, text: fresh.text, etag: fresh.etag }) });
      })
      .catch((error: unknown) => dispatch({ type: "saveFailed", error: toFileError(error) }));
  }, [read, workspaceId]);

  // Mine: move onto the version that is current and write over it, still conditionally.
  const onKeepMine = useCallback(() => {
    const current = stateRef.current.conflictEtag ?? stateRef.current.etag;
    dispatch({ type: "conflictOverridden" });
    if (current !== null) saveRef.current(current);
  }, []);

  if (note === null) return null;
  return { state, onChange, onSave, onDiscard, onUseTheirs, onKeepMine };
}
