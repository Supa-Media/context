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
import { useAction, useConvex, useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import type { FileBrowserOptions } from "./types";
import type { FolderIconsValues } from "./useFolderIcons";
import { useObjectMoves } from "../useObjectMoves";
import { objectServes } from "./objectServes";
import { useConsoleGrant } from "../../../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../../placeholderData";
import { appSearchUrl, searchThroughGateway } from "../../search/gatewaySearch";
import { noteReadUrl, readNoteThroughGateway } from "../gatewayNoteRead";

type FileActionsDeps = { options: FileBrowserOptions; folderIcons: FolderIconsValues };

export function useFileActions(deps: FileActionsDeps) {
  const { options, folderIcons } = deps;
  const { moved } = folderIcons;

  const workspaceId = options.workspaceId as Id<"workspaces"> | null;
  const workspaceGenerationRef = useRef({ workspaceId, epoch: 0 });
  if (workspaceGenerationRef.current.workspaceId !== workspaceId) {
    workspaceGenerationRef.current = { workspaceId, epoch: workspaceGenerationRef.current.epoch + 1 };
  }
  const slug = options.slug ?? null;

  /*
    One folder's listing, from the Convex tree (`nodesListing.listFolder`).
    The bucket is never listed for it (decided by the owner, 2026-10-13). The
    query answers `null` where the tree does not serve the workspace; then the
    `listFiles` action answers instead, from the same rows, and its refusal is
    the answer.
  */
  // Read through a ref: `listFiles` keeps one identity for the context's whole
  // life, because the root load re-runs (and resets the tree) whenever it changes.
  const convexClient = useConvex();
  const convex = useRef(convexClient);
  convex.current = convexClient;
  const listFilesAction = useAction(api.functions.files.listFiles);
  const listFiles = useCallback<typeof listFilesAction>(
    async (args) => {
      let fromTree = null;
      try {
        fromTree = await convex.current.query(api.functions.nodesListing.listFolder, args);
      } catch {
        // The action answers instead, from the same tree, and says why if it refuses.
      }
      return fromTree ?? (await listFilesAction(args));
    },
    [listFilesAction],
  );
  const readNoteAction = useAction(api.functions.files.readNote);
  const readNotesAction = useAction(api.functions.files.readNotes);
  const searchContextAction = useAction(api.functions.files.searchContext);
  const mintGrant = useConsoleGrant();
  /*
    A note is opened by the gateway, read in its workspace's object by the one copy of the editing-history engine
    (`gatewayNoteRead.ts`, Dev2 2026-11-11). The control plane's `readNote` answers only what the gateway hands back
    to it: a workspace not on its object yet, a picture, a Tex note, an old address to follow.
  */
  // Read through a ref, so `readNote` keeps one identity: effects that list it (`useOfflineQueue`) must not re-run
  // because a grant minter or a name was rebuilt.
  const noteReading = useRef({ readNoteAction, mintGrant, slug, workspaceId });
  noteReading.current = { readNoteAction, mintGrant, slug, workspaceId };
  const readNote = useCallback<typeof readNoteAction>(async (args) => {
    const now = noteReading.current;
    const url = typeof globalThis.fetch === "function" ? noteReadUrl(MCP_ENDPOINT, args.workspaceId === now.workspaceId ? now.slug : null) : null;
    if (url !== null) {
      const answer = await readNoteThroughGateway({
        url,
        token: async (refresh) => (await now.mintGrant({ workspaceId: args.workspaceId }, refresh)).accessToken,
        path: args.path,
      });
      if (answer !== null) return answer as Awaited<ReturnType<typeof readNoteAction>>;
    }
    return await now.readNoteAction(args);
  }, []);
  /*
    The bar asks the gateway first, the same search an AI client runs (`search/gatewaySearch.ts`), and the
    control plane's `searchContext` only when no answer came back from it (the search revamp, 2026-11-04).
  */
  const searchContext = useCallback<typeof searchContextAction>(
    async (args) => {
      const url = appSearchUrl(MCP_ENDPOINT);
      if (url !== null && slug !== null) {
        const answer = await searchThroughGateway({
          url,
          token: async (refresh) => (await mintGrant({ workspaceId: args.workspaceId }, refresh)).accessToken,
          query: args.query,
          slug,
          ...(args.prefix === undefined ? {} : { prefix: args.prefix }),
        });
        if (answer !== null) return answer as Awaited<ReturnType<typeof searchContextAction>>;
      }
      return await searchContextAction(args);
    },
    [searchContextAction, mintGrant, slug],
  );
  const reportSearchScreen = useMutation(api.functions.searchTimings.reportScreen);
  const reportSearchOpen = useMutation(api.functions.searchTimings.reportOpen);
  const notePathsAction = useAction(api.functions.files.notePaths);
  const exportAccessAction = useAction(api.functions.exportAccess.exportAccess);
  const listOldCopiesAction = useAction(api.functions.oldCopies.listForExport);
  const readOldCopiesAction = useAction(api.functions.oldCopies.readForExport);
  const readMessagesLogAction = useAction(api.functions.messagesExport.readLogForExport);
  const readChatLedgerAction = useAction(api.functions.texLedgerExport.readChatLedgerForExport);
  const listChatLedgersAction = useAction(api.functions.texLedgerExport.listChatLedgersForExport);
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
  // Trash, restore and moves go to the workspace's object when it serves the tree (`useObjectMoves`).
  // Each file operation is addressed to its workspace by name, where that is the workspace on screen.
  const slugOf = useCallback((id: string) => (id === workspaceId ? slug : null), [workspaceId, slug]);
  const objectMoves = useObjectMoves(slugOf);
  const moveEntryAction = useAction(api.functions.files.moveEntry);
  const moveEntry = useCallback<typeof moveEntryAction>(
    async (args) => {
      // A rename that also rewrites the note's first heading edits its text, which only the action does.
      const result =
        (args.followHeading === true
          ? null
          : await objectMoves.move(args.workspaceId, {
              from: args.from,
              to: args.to,
              ...(args.expectedEtag === undefined ? {} : { expectedEtag: args.expectedEtag }),
            })) ?? (await moveEntryAction(args));
      moved(args.from, args.to);
      return result;
    },
    [moveEntryAction, moved, objectMoves],
  );
  const startContextMoveAction = useAction(api.functions.contextMoves.startContextMove);
  const resumeContextMoveAction = useAction(api.functions.contextMoves.resumeContextMove);
  const dismissContextMoveMutation = useMutation(api.functions.contextMoves.dismissContextMove);
  // Copy and Duplicate of a note go to the gateway too, which makes the copy and the object adopts it; a folder, or
  // anything else the gateway leaves to Convex, answers null and takes the action. A workspace the object does not
  // serve calls the action at once, exactly as before.
  const copyEntryAction = useAction(api.functions.files.copyEntry);
  const copyEntry = useCallback<typeof copyEntryAction>(
    (args) =>
      objectServes(args.workspaceId)
        ? objectMoves.copy(args.workspaceId, { from: args.from, to: args.to }).then((moved) => moved ?? copyEntryAction(args))
        : copyEntryAction(args),
    [copyEntryAction, objectMoves],
  );
  const duplicateEntryAction = useAction(api.functions.files.duplicateEntry);
  const duplicateEntry = useCallback<typeof duplicateEntryAction>(
    (args) =>
      objectServes(args.workspaceId)
        ? objectMoves.duplicate(args.workspaceId, { path: args.path }).then((moved) => moved ?? duplicateEntryAction(args))
        : duplicateEntryAction(args),
    [duplicateEntryAction, objectMoves],
  );
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
  /*
    Trash and restore go to the workspace's object through the gateway when it
    serves the tree (`objectServes`), and to the Convex action otherwise, or when
    the gateway cannot answer. A refusal from the gateway is thrown as the
    action's own refusal, so it is not retried against Convex.
  */
  const trashEntryAction = useAction(api.functions.files.trashEntry);
  const trashEntry = useCallback<typeof trashEntryAction>(
    async (args) => {
      const result =
        (await objectMoves.trash(args.workspaceId, {
          path: args.path,
          ...(args.expectedEtag === undefined ? {} : { expectedEtag: args.expectedEtag }),
        })) ?? (await trashEntryAction(args));
      moved(args.path, result.to);
      return result;
    },
    [moved, objectMoves, trashEntryAction],
  );
  const restoreTrashEntryAction = useAction(api.functions.files.restoreTrashEntry);
  const restoreTrashEntry = useCallback<typeof restoreTrashEntryAction>(
    async (args) => {
      const result =
        (await objectMoves.restore(args.workspaceId, { from: args.from, to: args.to })) ??
        (await restoreTrashEntryAction(args));
      moved(args.from, args.to);
      return result;
    },
    [moved, objectMoves, restoreTrashEntryAction],
  );
  const setNoteVisibility = useAction(api.functions.files.setNoteVisibility);
  const setNoteGroupAction = useAction(api.functions.files.setNoteGroup);
  const setFolderGroupAction = useAction(api.functions.files.setFolderGroup);
  const setDirectoryVisibility = useAction(api.functions.files.setDirectoryVisibility);
  const updateStorageLayoutAction = useAction(api.functions.files.updateStorageLayout);

  return {
    workspaceId, workspaceGenerationRef, slug, listFiles, readNote, readNotesAction, searchContext, reportSearchScreen, reportSearchOpen, notePathsAction,
    writeNote, submitFormAction, storeNoteImageAction, readNoteImageAction, readRemoteImageAction, readEmojiAction, imageCache, exportAccessAction,
    listOldCopiesAction, readOldCopiesAction, readMessagesLogAction, readChatLedgerAction, listChatLedgersAction,
    voteFormAction, updateSubmissionAction, retractSubmissionAction, createDirectory, undoNewFolder, moveEntry,
    startContextMoveAction, resumeContextMoveAction, dismissContextMoveMutation,
    copyEntry, duplicateEntry, archiveEntry, trashEntry, restoreTrashEntry, setNoteVisibility,
    setNoteGroupAction, setFolderGroupAction, setDirectoryVisibility,
    updateStorageLayoutAction,
  };
}

export type FileActionsValues = ReturnType<typeof useFileActions>;
