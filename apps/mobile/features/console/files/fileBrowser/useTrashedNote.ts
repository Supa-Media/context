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
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { toFileError } from "../browser";
import type { TrashedNote } from "../browser/supportingTypes";
import { parentPath } from "../paths";
import { raceTimeout } from "../../storage/timeout";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { ListingsValues } from "./useListings";
import type { OpenNoteValues } from "./useOpenNote";

/** How long Restore waits for the folder to list the note again before going on without it. */
export const RESTORE_LISTING_WAIT_MS = 5_000;

type TrashedNoteDeps =
  & Pick<FileActionsValues, "restoreTrashEntry" | "workspaceId" | "workspaceGenerationRef">
  & Pick<BrowserStateValues, "autosave" | "editor" | "setNotice">
  & Pick<ListingsValues, "refresh">
  & Pick<OpenNoteValues, "openNote">;

export function useTrashedNote(deps: TrashedNoteDeps) {
  const { autosave, editor, openNote, refresh, restoreTrashEntry, setNotice, workspaceId, workspaceGenerationRef } = deps;
  const convex = useConvex();
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

  /** This tab's delete landed: Restore now knows where to take it back from. */
  const settleTrashed = useCallback((path: string, trash: string) => {
    const current = trashedRef.current;
    if (current?.path === path) markTrashed({ ...current, trash });
  }, [markTrashed]);

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
    if (shown === null || shown.trash === null || workspaceId === null || restoringTrashed) return;
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

  return {
    trashed, trashedRef, markTrashed, settleTrashed, clearTrashed, lookUpTrashed, restoreTrashed, restoringTrashed,
    holdOpen, keptOpen,
  };
}

export type TrashedNoteValues = ReturnType<typeof useTrashedNote>;
