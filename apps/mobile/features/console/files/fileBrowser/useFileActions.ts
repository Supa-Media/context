/**
 * The Convex actions and mutations this hook binds, the context it binds them to,
 * and the image cache that sits between them.
 *
 * Part of `useFileBrowser`, moved out of that file verbatim. The facade calls
 * each part in the order the code used to run, so every hook is still called
 * in the same order with the same dependency lists; what a part reads from an
 * earlier one arrives in `deps`, and is the same value the code closed over
 * before.
 */
import { useRef } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import type { FileBrowserOptions } from "./types";

type FileActionsDeps = { options: FileBrowserOptions };

export function useFileActions(deps: FileActionsDeps) {
  const { options } = deps;

  const workspaceId = options.workspaceId as Id<"workspaces"> | null;
  const slug = options.slug ?? null;

  const listFiles = useAction(api.functions.files.listFiles);
  const readNote = useAction(api.functions.files.readNote);
  const readNotesAction = useAction(api.functions.files.readNotes);
  const searchContext = useAction(api.functions.files.searchContext);
  const notePathsAction = useAction(api.functions.files.notePaths);
  const writeNote = useAction(api.functions.files.writeNote);
  const submitFormAction = useAction(api.functions.forms.submitForm);
  const storeNoteImageAction = useAction(api.functions.files.storeNoteImage);
  const readNoteImageAction = useAction(api.functions.files.readNoteImage);
  const readRemoteImageAction = useAction(api.functions.files.readRemoteImage);
  /**
   * Every image this session has already fetched, by workspace and key.
   *
   * A ref rather than state: nothing re-renders when it changes — the `<img>`
   * that asked is handed the src directly — and a state update per image would
   * re-render the whole browser once per picture in the note.
   */
  const imageCache = useRef(new Map<string, string>());
  const voteFormAction = useAction(api.functions.forms.voteForm);
  const updateSubmissionAction = useAction(api.functions.forms.updateSubmission);
  const retractSubmissionAction = useAction(api.functions.forms.retractSubmission);
  const createDirectory = useAction(api.functions.files.createDirectory);
  const moveEntry = useAction(api.functions.files.moveEntry);
  const folderPathsAction = useAction(api.functions.files.folderPaths);
  const startContextMoveAction = useAction(api.functions.contextMoves.startContextMove);
  const resumeContextMoveAction = useAction(api.functions.contextMoves.resumeContextMove);
  const dismissContextMoveMutation = useMutation(api.functions.contextMoves.dismissContextMove);
  const copyEntry = useAction(api.functions.files.copyEntry);
  const duplicateEntry = useAction(api.functions.files.duplicateEntry);
  const archiveEntry = useAction(api.functions.files.archiveEntry);
  const trashEntry = useAction(api.functions.files.trashEntry);
  const restoreTrashEntry = useAction(api.functions.files.restoreTrashEntry);
  const setNoteVisibility = useAction(api.functions.files.setNoteVisibility);
  const setNoteGroupAction = useAction(api.functions.files.setNoteGroup);
  const setFolderGroupAction = useAction(api.functions.files.setFolderGroup);
  const setDirectoryVisibility = useAction(api.functions.files.setDirectoryVisibility);
  const resetPrivacyAction = useAction(api.functions.files.resetPrivacy);
  const updateStorageLayoutAction = useAction(api.functions.files.updateStorageLayout);

  return {
    workspaceId, slug, listFiles, readNote, readNotesAction, searchContext, notePathsAction,
    writeNote, submitFormAction, storeNoteImageAction, readNoteImageAction, readRemoteImageAction, imageCache,
    voteFormAction, updateSubmissionAction, retractSubmissionAction, createDirectory, moveEntry,
    folderPathsAction, startContextMoveAction, resumeContextMoveAction, dismissContextMoveMutation,
    copyEntry, duplicateEntry, archiveEntry, trashEntry, restoreTrashEntry, setNoteVisibility,
    setNoteGroupAction, setFolderGroupAction, setDirectoryVisibility, resetPrivacyAction,
    updateStorageLayoutAction,
  };
}

export type FileActionsValues = ReturnType<typeof useFileActions>;
