/**
 * The open note, in the trash and still on screen (design A, Dev2 2026-10-14,
 * project file `trashed-note/`).
 *
 * Deleting the note somebody is reading used to close it, and somebody else
 * deleting it said "moved or deleted somewhere else" under a page that went on
 * looking editable. Now both keep the note where it is, dimmed and read-only,
 * with Restore in Share's place: the way back is on the page that went, not in
 * a toast that times out.
 *
 * One state, held here, for the two ways in: this tab's own delete
 * (`useRowCommands.destroy`) and a delete made anywhere else, which
 * `useFollowMoves` sees as the note leaving its folder and asks Convex about
 * (`trashedNotes.trashedNote`). It belongs to one path, and it goes the moment
 * the editor is on another note, so opening something else is all it takes to
 * leave it.
 *
 * While it holds, the autosave writes nothing for that path (`useSaving`): a
 * write there would put the note back at its old name behind the trash's back.
 * What was on screen is kept as it was, typed words included, and Restore
 * carries them back with the note.
 *
 * Two more ways in, each the same state: a delete that waits in this device's
 * queue (`queueRemovalOf`), whose Restore takes it back out of the queue until
 * it lands and learns its trash key when it does (`onOpLanded`); and a note
 * opened by an address that outlived it (a reload on `?note=`), shown with the
 * text the trash holds (`trashedNotes.readTrashedNote`) instead of "That file
 * does not exist" (`openMissing`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useConvex } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { toFileError } from "../browser";
import type { TrashedNote } from "../browser/supportingTypes";
import { parentPath } from "../paths";
import { raceTimeout } from "../../storage/timeout";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { ListingsValues } from "./useListings";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { OpenNoteValues } from "./useOpenNote";

/** How long Restore waits for the folder to list the note again before going on without it. */
export const RESTORE_LISTING_WAIT_MS = 5_000;

/** Restore pressed while the delete is on its way from this device's queue. */
export const QUEUED_TRASH_SENDING =
  "This delete is already on its way to your bucket. Restore will work as soon as it lands.";

/** A trashed note opened by its address, whose text the trash could not give back. */
export const TRASHED_TEXT_UNAVAILABLE = "This note is in the trash. Restore it to read it here.";

type TrashedNoteDeps =
  & Pick<FileActionsValues, "restoreTrashEntry" | "workspaceId" | "workspaceGenerationRef">
  & Pick<BrowserStateValues, "autosave" | "dispatch" | "editor" | "setNotice">
  & Pick<ListingsValues, "refresh">
  & Pick<OfflineQueueValues, "onOpLanded">
  & Pick<OpenNoteValues, "openMissing" | "openNote">;

export function useTrashedNote(deps: TrashedNoteDeps) {
  const {
    autosave, dispatch, editor, onOpLanded, openMissing, openNote, refresh, restoreTrashEntry, setNotice, workspaceId,
    workspaceGenerationRef,
  } = deps;
  const convex = useConvex();
  const readTrashedNote = useAction(api.functions.trashedNotes.readTrashedNote);
  const [trashed, setTrashed] = useState<TrashedNote | null>(null);
  const [restoringTrashed, setRestoring] = useState(false);
  /** Read from callbacks that outlive a render: the follow timer, the autosave. */
  const trashedRef = useRef(trashed);

  const markTrashed = useCallback((next: TrashedNote | null) => {
    trashedRef.current = next;
    setTrashed(next);
    // Nothing more is written to a name the note has left.
    if (next !== null && autosave.pending() === next.path) autosave.cancel();
  }, [autosave]);

  /** This tab's delete landed: Restore now knows where to take it back from, and the queue has no say in it. */
  const settleTrashed = useCallback((path: string, trash: string) => {
    const current = trashedRef.current;
    if (current?.path !== path) return;
    const { undoQueued: _sent, ...rest } = current;
    markTrashed({ ...rest, trash });
  }, [markTrashed]);

  // A delete that waited in this device's queue reached the bucket, with the key it went to.
  useEffect(
    () =>
      onOpLanded((done) => {
        if (done.kind !== "trash" || done.trash === undefined) return;
        if (trashedRef.current?.path === done.path && trashedRef.current.trash === null) settleTrashed(done.path, done.trash);
      }),
    [onOpLanded, settleTrashed],
  );

  /** This tab's delete was refused: the note never left. */
  const clearTrashed = useCallback((path: string) => {
    if (trashedRef.current?.path === path) markTrashed(null);
  }, [markTrashed]);

  /**
   * The open note left its folder, and `useFollowMoves` is finding out where
   * it went. Until the editor moves on, its tab is not closed for being
   * missing from the listing: the answer is a new name, the trash, or a note
   * left on screen with a notice — never a page that vanished first.
   */
  const [held, setHeld] = useState<string | null>(null);
  const holdOpen = useCallback((path: string) => setHeld(path), []);

  /*
    Another note open, or none: the state was about the one that went. Also
    a context switch, which empties the editor.
  */
  useEffect(() => {
    if (trashedRef.current !== null && trashedRef.current.path !== editor.path) markTrashed(null);
    setHeld((current) => (current !== null && current !== editor.path ? null : current));
  }, [editor.path, markTrashed]);
  /** The open note its folder no longer lists, kept open on purpose. */
  const keptOpen = trashed?.path ?? held;

  /**
   * Where a note that just left its folder went, when that was the trash:
   * `null` for anything else (deleted for good, moved out of this person's
   * sight), and for a failed ask, which then reads as the old notice.
   */
  const lookUpTrashed = useCallback(
    async (path: string): Promise<Omit<TrashedNote, "path"> | null> => {
      if (workspaceId === null) return null;
      try {
        return await convex.query(api.functions.trashedNotes.trashedNote, { workspaceId, path });
      } catch {
        return null;
      }
    },
    [convex, workspaceId],
  );

  const restoreTrashed = useCallback(() => {
    const shown = trashedRef.current;
    if (shown === null || workspaceId === null || restoringTrashed) return;
    if (shown.trash === null) {
      // Still in this device's queue: taken back out of it, the note never left.
      if (shown.undoQueued === undefined) return;
      if (shown.undoQueued()) markTrashed(null);
      else setNotice(QUEUED_TRASH_SENDING);
      return;
    }
    const epoch = workspaceGenerationRef.current.epoch;
    setRestoring(true);
    void (async () => {
      try {
        await restoreTrashEntry({ workspaceId, from: shown.trash!, to: shown.path });
        /*
          Its folder listed again first: the tab strip closes a tab whose
          folder does not hold its note, and only the trashed state was
          keeping this one open.
        */
        await raceTimeout(refresh([parentPath(shown.path)]).catch(() => null), {
          ms: RESTORE_LISTING_WAIT_MS,
          schedule: (fn, ms) => setTimeout(fn, ms),
          cancel: (handle) => clearTimeout(handle),
        });
        if (workspaceGenerationRef.current.epoch !== epoch || trashedRef.current !== shown) return;
        markTrashed(null);
        // Read it back where it is now, keeping anything typed before it went.
        void openNote(shown.path, shown.path);
      } catch (error) {
        if (workspaceGenerationRef.current.epoch === epoch) setNotice(toFileError(error).message);
      } finally {
        if (workspaceGenerationRef.current.epoch === epoch) setRestoring(false);
      }
    })();
  }, [markTrashed, openNote, refresh, restoreTrashEntry, restoringTrashed, setNotice, workspaceId, workspaceGenerationRef]);

  /**
   * Put back by something other than Restore (a batch's Undo): the editor
   * goes on at that path, read again, its tab held while its folder catches up.
   */
  const restoredInPlace = useCallback((path: string) => {
    if (trashedRef.current?.path !== path) return;
    setHeld(path);
    markTrashed(null);
    void openNote(path, path);
  }, [markTrashed, openNote]);

  /*
    A note opened by an address that outlived it: in the trash, it opens
    there, read-only, with the text the trash holds; without it, quietly empty
    and saying so. `false` for anything else, which reads as not found.
  */
  const showTrashedInstead = useCallback(
    async (path: string, current: () => boolean): Promise<boolean> => {
      if (workspaceId === null) return false;
      const answer = await lookUpTrashed(path);
      if (answer === null || !current()) return false;
      const body = await readTrashedNote({ workspaceId, path }).catch(() => null);
      if (!current()) return true;
      dispatch({
        type: "opened",
        note: {
          path,
          text: body?.text ?? "",
          etag: "",
          visibility: "private",
          inherited: "private",
          exception: false,
          readOnly: true,
          ...(body?.encrypted === true ? { encrypted: true } : {}),
        },
      });
      markTrashed({ ...answer, path });
      if (body === null) setNotice(TRASHED_TEXT_UNAVAILABLE);
      return true;
    },
    [dispatch, lookUpTrashed, markTrashed, readTrashedNote, setNotice, workspaceId],
  );
  openMissing.current = showTrashedInstead;

  return {
    trashed, trashedRef, markTrashed, settleTrashed, clearTrashed, lookUpTrashed, restoreTrashed, restoringTrashed,
    restoredInPlace, holdOpen, keptOpen,
  };
}

export type TrashedNoteValues = ReturnType<typeof useTrashedNote>;
