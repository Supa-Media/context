/**
 * The `FileBrowser` the hook hands back, memoised on everything in it.
 *
 * Part of `useFileBrowser`, moved out of that file verbatim. The facade calls
 * each part in the order the code used to run, so every hook is still called
 * in the same order with the same dependency lists; what a part reads from an
 * earlier one arrives in `deps`, and is the same value the code closed over
 * before.
 */
import type { FileBrowser } from "../browser";
import { useMemo } from "react";
import { put } from "../clipboard";
import { localPathOf, opsOf } from "../../../offline/outbox";
import { canResetPrivacy, canSetVisibility } from "../../capabilities";
import { describeOp } from "../pendingMarks";
import type { FileBrowserOptions } from "./types";
import type { BatchValues } from "./useBatch";
import type { BrowserStateValues } from "./useBrowserState";
import type { ConflictsAndDraftsValues } from "./useConflictsAndDrafts";
import type { ContextMovesValues } from "./useContextMoves";
import type { CreateAndMoveValues } from "./useCreateAndMove";
import type { ListingsValues } from "./useListings";
import type { NoteReadsValues } from "./useNoteReads";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { OpenNoteValues } from "./useOpenNote";
import type { PendingOpsValues } from "./usePendingOps";
import type { RowCommandsValues } from "./useRowCommands";
import type { SavingValues } from "./useSaving";
import type { ShareScopeValues } from "./useShareScope";
import type { SharesValues } from "./useShares";
import type { VisibilityValues } from "./useVisibility";
import type { WritesAndImagesValues } from "./useWritesAndImages";

type FileBrowserValueDeps =
  & { options: FileBrowserOptions }
  & Pick<
    BrowserStateValues,
    | "busy"
    | "clipboard"
    | "dismissToast"
    | "editor"
    | "expanded"
    | "loading"
    | "navigations"
    | "notice"
    | "opening"
    | "say"
    | "selectedPath"
    | "setClipboard"
    | "toasts"
  >
  & Pick<WritesAndImagesValues, "loadImage" | "storeImage" | "submitForm">
  & Pick<
    OfflineQueueValues,
    | "listings"
    | "mirrorStatus"
    | "offline"
    | "onExternalWrite"
    | "onSaved"
  >
  & Pick<
    NoteReadsValues,
    | "conflict"
    | "readFormResponses"
    | "readRaw"
    | "retractFormResponse"
    | "updateFormResponse"
    | "voteForm"
  >
  & Pick<ListingsValues, "collapseAll" | "contextId" | "ensureListing" | "search" | "toggleFolder">
  & Pick<OpenNoteValues, "deselect" | "select">
  & Pick<SavingValues, "flushAutosave" | "save">
  & Pick<
    ConflictsAndDraftsValues,
    | "applyPluginNoteWrite"
    | "discard"
    | "discardLocalCopies"
    | "dismissNotice"
    | "encryptedElsewhere"
    | "keepMine"
    | "resolveWith"
    | "setCollaborationDraft"
    | "setCollaborationOwned"
    | "setCollaborationState"
    | "setDraft"
    | "useTheirs"
  >
  & Pick<
    CreateAndMoveValues,
    | "createDrawing"
    | "createFolder"
    | "createNote"
    | "createUntitled"
    | "move"
  >
  & Pick<
    ContextMovesValues,
    | "contextMoves"
    | "destinationFolders"
    | "dismissContextMove"
    | "moveDestinations"
    | "moveToContext"
    | "resumeContextMove"
  >
  & Pick<
    RowCommandsValues,
    | "archive"
    | "copyTo"
    | "destroy"
    | "download"
    | "duplicate"
    | "paste"
    | "rename"
  >
  & Pick<BatchValues, "archiveMany" | "copyManyTo" | "destroyMany" | "moveMany" | "restoreMany">
  & Pick<VisibilityValues, "resetPrivacy" | "setVisibility" | "updateStorageLayout">
  & Pick<
    SharesValues,
    | "copyShareLink"
    | "linkPaths"
    | "mayShare"
    | "openLinkPaths"
    | "revokeShare"
    | "setShareCollecting"
    | "setShareSlug"
    | "share"
    | "shares"
  >
  & Pick<ShareScopeValues, "setScope" | "setSharePreviewTitle" | "shareWithGroup">
  & Pick<PendingOpsValues, "answerOp" | "pending">;

export function useFileBrowserValue(deps: FileBrowserValueDeps): FileBrowser {
  const {
    options, answerOp, applyPluginNoteWrite, archive, archiveMany, busy, clipboard, collapseAll,
    conflict, contextId, contextMoves, copyManyTo, copyShareLink, copyTo, createDrawing,
    createFolder, createNote, createUntitled, deselect, destinationFolders, destroy, destroyMany,
    discard, discardLocalCopies, dismissContextMove, dismissNotice, dismissToast, download,
    duplicate, editor, encryptedElsewhere, ensureListing, expanded, flushAutosave, keepMine,
    linkPaths, listings, loadImage, loading, mayShare, mirrorStatus, move, moveDestinations,
    moveMany, moveToContext, navigations, notice, offline, onExternalWrite, onSaved, openLinkPaths,
    opening, paste, pending, readFormResponses, readRaw, rename, resetPrivacy, resolveWith,
    restoreMany, resumeContextMove, retractFormResponse, revokeShare, save, say, search, select,
    selectedPath, setClipboard, setCollaborationDraft, setCollaborationOwned,
    setCollaborationState, setDraft, setScope, setShareCollecting, setSharePreviewTitle,
    setShareSlug, setVisibility, share, shareWithGroup, shares, storeImage, submitForm, toasts,
    toggleFolder, updateFormResponse, updateStorageLayout, useTheirs, voteForm,
  } = deps;

  return useMemo(
    () => ({
      canEdit: options.canEdit,
      submitForm,
      loadImage,
      storeImage,
      readFormResponses,
      voteForm,
      updateFormResponse,
      retractFormResponse,
      readOnlyReason: options.readOnlyReason,
      contextId,
      loading,
      busy,
      listings,
      expanded,
      toggleFolder,
      collapseAll,
      selectedPath,
      opening,
      select,
      navigations,
      deselect,
      search,
      editor,
      setDraft,
      setCollaborationOwned,
      setCollaborationDraft,
      setCollaborationState,
      save,
      onExternalWrite,
      onSaved,
      applyPluginNoteWrite,
      flushAutosave,
      discardLocalCopies,
      encryptedElsewhere,
      useTheirs,
      keepMine,
      conflict,
      resolveWith,
      discard,
      sync: {
        reachability: offline.reachability,
        counts: offline.counts,
        ready: offline.ready,
        durable: offline.durable,
        conditionalWrite: options.conditionalWrite,
        stuckPaths: [
          ...offline.outbox.writes
            .filter((write) => write.state !== "pending")
            .map((write) => localPathOf(offline.outbox, write.path)),
          ...opsOf(offline.outbox)
            .filter((op) => op.state !== "pending")
            .map((op) => describeOp(op)),
        ],
        ...(mirrorStatus === undefined ? {} : { mirror: mirrorStatus }),
      },
      pending,
      answerOp,
      notice,
      dismissNotice,
      toasts,
      say,
      dismissToast,
      clipboard,
      copy: (path: string) => setClipboard(put("copy", path)),
      cut: (path: string) => setClipboard(put("cut", path)),
      paste,
      copyTo,
      createNote,
      createDrawing,
      createFolder,
      createUntitled,
      rename,
      move,
      moveDestinations,
      destinationFolders,
      moveToContext,
      contextMoves,
      resumeContextMove,
      dismissContextMove,
      duplicate,
      download,
      archive,
      destroy,
      moveMany,
      copyManyTo,
      archiveMany,
      restoreMany,
      destroyMany,
      setVisibility,
      shareWithGroup,
      setScope,
      openLinkPaths,
      linkPaths,
      resetPrivacy,
      updateStorageLayout: options.isOwner === true ? updateStorageLayout : undefined,
      // A control that cannot work is a control that is not drawn. All three
      // have to hold: the manifest is broken, this is the owner, and this
      // console can act.
      // Both derived in `../capabilities`, not here. Inline, each was
      // unreachable by any test — dropping the `isOwner` half of either failed
      // nothing across 1476 checks, and `canSetVisibility` is the capability
      // the console's one real authorization defect was about.
      canResetPrivacy: canResetPrivacy(
        { canEdit: options.canEdit, isOwner: options.isOwner === true },
        listings[""]?.manifestUsable,
      ),
      canSetVisibility: canSetVisibility({
        canEdit: options.canEdit,
        isOwner: options.isOwner === true,
      }),
      canShare: mayShare,
      // A real console always has one. See `canDownload` in `browser.ts` for
      // why this is a capability rather than a permission.
      canDownload: true,
      copyShareLink,
      shares,
      share,
      revokeShare,
      setShareSlug,
      setShareCollecting,
      setSharePreviewTitle,
      ensureListing,
      readRaw,
    }),
    [
      submitForm,
      loadImage,
      storeImage,
      readFormResponses,
      voteForm,
      updateFormResponse,
      retractFormResponse,
      archive,
      busy,
      clipboard,
      contextId,
      copyTo,
      createFolder,
      createNote,
      createDrawing,
      createUntitled,
      destroy,
      moveMany,
      copyManyTo,
      archiveMany,
      restoreMany,
      destroyMany,
      discard,
      discardLocalCopies,
      encryptedElsewhere,
      dismissNotice,
      dismissToast,
      download,
      duplicate,
      editor,
      expanded,
      conflict,
      flushAutosave,
      keepMine,
      linkPaths,
      listings,
      loading,
      move,
      moveDestinations,
      destinationFolders,
      moveToContext,
      contextMoves,
      resumeContextMove,
      dismissContextMove,
      notice,
      mirrorStatus,
      offline.counts,
      offline.durable,
      offline.outbox,
      offline.reachability,
      offline.ready,
      pending,
      answerOp,
      options.canEdit,
      options.conditionalWrite,
      options.isOwner,
      options.readOnlyReason,
      paste,
      rename,
      resetPrivacy,
      updateStorageLayout,
      resolveWith,
      save,
      applyPluginNoteWrite,
      search,
      select,
      navigations,
      deselect,
      selectedPath,
      opening,
      setDraft,
      setCollaborationOwned,
      setCollaborationDraft,
      setVisibility,
      shareWithGroup,
      setScope,
      openLinkPaths,
      share,
      revokeShare,
      setShareSlug,
      setShareCollecting,
      toasts,
      setSharePreviewTitle,
      copyShareLink,
      shares,
      mayShare,
      toggleFolder,
      collapseAll,
      useTheirs,
      ensureListing,
      readRaw,
    ],
  );
}
