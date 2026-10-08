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
import { useCallback, useRef } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import type { FileBrowserOptions } from "./types";
import type { FolderIconsValues } from "./useFolderIcons";

type FileActionsDeps = { options: FileBrowserOptions; folderIcons: FolderIconsValues };

export function useFileActions(deps: FileActionsDeps) {
  const { options, folderIcons } = deps;
  const { moved } = folderIcons;

  const workspaceId = options.workspaceId as Id<"workspaces"> | null;
  const slug = options.slug ?? null;

  const listFiles = useAction(api.functions.files.listFiles);
  const readNote = useAction(api.functions.files.readNote);
  const readNotesAction = useAction(api.functions.files.readNotes);
  const searchContext = useAction(api.functions.files.searchContext);
  const reportSearchScreen = useMutation(api.functions.searchTimings.reportScreen);
  const notePathsAction = useAction(api.functions.files.notePaths);
  const writeNote = useAction(api.functions.files.writeNote);
  const submitFormAction = useAction(api.functions.forms.submitForm);
  const storeNoteImageAction = useAction(api.functions.files.storeNoteImage);
  const readNoteImageAction = useAction(api.functions.files.readNoteImage);
  const readRemoteImageAction = useAction(api.functions.files.readRemoteImage);
  const readEmojiAction = useAction(api.functions.emoji.read);
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
  const undoNewFolder = useAction(api.functions.folders.undoNewFolder);
  /*
    The four actions that put a folder somewhere else are wrapped here, once,
    so the icon follows the folder on screen whichever caller moved it: rename,
    move, undo, a batch, and an offline replay all come through these. The
    server remaps the icon in the bucket (`folderIcons.cjs`), and this keeps the
    screen in step without a second read. A failed call moves nothing and
    rethrows, as the bare action does.
  */
  const moveEntryAction = useAction(api.functions.files.moveEntry);
  const moveEntry = useCallback<typeof moveEntryAction>(
    async (args) => {
      const result = await moveEntryAction(args);
      moved(args.from, args.to);
      return result;
    },
    [moveEntryAction, moved],
  );
  const startContextMoveAction = useAction(api.functions.contextMoves.startContextMove);
  const resumeContextMoveAction = useAction(api.functions.contextMoves.resumeContextMove);
  const dismissContextMoveMutation = useMutation(api.functions.contextMoves.dismissContextMove);
  const copyEntry = useAction(api.functions.files.copyEntry);
  const duplicateEntry = useAction(api.functions.files.duplicateEntry);
  // Archive, trash and restore are moves too: the answer says where the folder went.
  const archiveEntryAction = useAction(api.functions.files.archiveEntry);
  const archiveEntry = useCallback<typeof archiveEntryAction>(
    async (args) => {
      const result = await archiveEntryAction(args);
      moved(args.path, result.to);
      return result;
    },
    [archiveEntryAction, moved],
  );
  const trashEntryAction = useAction(api.functions.files.trashEntry);
  const trashEntry = useCallback<typeof trashEntryAction>(
    async (args) => {
      const result = await trashEntryAction(args);
      moved(args.path, result.to);
      return result;
    },
    [moved, trashEntryAction],
  );
  const restoreTrashEntryAction = useAction(api.functions.files.restoreTrashEntry);
  const restoreTrashEntry = useCallback<typeof restoreTrashEntryAction>(
    async (args) => {
      const result = await restoreTrashEntryAction(args);
      moved(args.from, args.to);
      return result;
    },
    [moved, restoreTrashEntryAction],
  );
  const setNoteVisibility = useAction(api.functions.files.setNoteVisibility);
  const setNoteGroupAction = useAction(api.functions.files.setNoteGroup);
  const setFolderGroupAction = useAction(api.functions.files.setFolderGroup);
  const setDirectoryVisibility = useAction(api.functions.files.setDirectoryVisibility);
  const resetPrivacyAction = useAction(api.functions.files.resetPrivacy);
  const updateStorageLayoutAction = useAction(api.functions.files.updateStorageLayout);

  return {
    workspaceId, slug, listFiles, readNote, readNotesAction, searchContext, reportSearchScreen, notePathsAction,
    writeNote, submitFormAction, storeNoteImageAction, readNoteImageAction, readRemoteImageAction, readEmojiAction, imageCache,
    voteFormAction, updateSubmissionAction, retractSubmissionAction, createDirectory, undoNewFolder, moveEntry,
    startContextMoveAction, resumeContextMoveAction, dismissContextMoveMutation,
    copyEntry, duplicateEntry, archiveEntry, trashEntry, restoreTrashEntry, setNoteVisibility,
    setNoteGroupAction, setFolderGroupAction, setDirectoryVisibility, resetPrivacyAction,
    updateStorageLayoutAction,
  };
}

export type FileActionsValues = ReturnType<typeof useFileActions>;
