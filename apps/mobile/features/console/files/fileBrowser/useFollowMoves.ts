/**
 * The open note, following a move made somewhere else (phase 2 of the tree's
 * move into Convex, `docs/decisions/app-and-console/convex-tree.md`).
 *
 * Before this, the editor followed a rename only when this same tab made it
 * (`followRename`). A colleague, an agent or another tab moving the open note
 * left this tab editing a name the bucket no longer had. Now the live listing
 * of the note's folder says when the note left it (`useLiveTree`'s
 * `onVanished`), and the note is read again at its old name: the read follows
 * the forwarding ledger the move wrote, and the editor goes on to the new name
 * with whatever it was holding, exactly as for a rename made here.
 *
 * Two things keep it from acting on this tab's own moves. It waits
 * `FOLLOW_DELAY_MS` first, in which this tab's own rename has already moved
 * the editor on; and it acts only while nothing else has opened since and no
 * rename of this tab's is in flight.
 *
 * A note that went to the trash stays on screen as a trashed note, with
 * Restore (`useTrashedNote`): Convex says where it went and who moved it. One
 * deleted for good, or moved where this person cannot read it, says so and is
 * left on screen too, so nothing typed is lost either way. A note this tab
 * already holds as trashed is its own delete, and is left alone.
 */
import { useEffect } from "react";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { ListingsValues } from "./useListings";
import type { OpenNoteValues } from "./useOpenNote";
import type { TrashedNoteValues } from "./useTrashedNote";

/** Long enough for this tab's own rename to have moved the editor already. */
export const FOLLOW_DELAY_MS = 1_500;

export const MOVED_ELSEWHERE =
  "This note was moved or deleted somewhere else. What you see here has not been saved anywhere new.";

type FollowDeps =
  & Pick<FileActionsValues, "readNote" | "workspaceId" | "workspaceGenerationRef">
  & Pick<BrowserStateValues, "editorRef" | "openRun" | "renamingRef" | "setNotice">
  & Pick<ListingsValues, "subscribeVanished">
  & Pick<OpenNoteValues, "followRename">
  & Pick<TrashedNoteValues, "holdOpen" | "lookUpTrashed" | "markTrashed" | "trashedRef">;

export function useFollowMoves(deps: FollowDeps): void {
  const {
    readNote, workspaceId, workspaceGenerationRef, editorRef, openRun, renamingRef, setNotice, subscribeVanished, followRename,
    holdOpen, lookUpTrashed, markTrashed, trashedRef,
  } = deps;
  useEffect(() => {
    if (workspaceId === null) return;
    let live = true;
    const unsubscribe = subscribeVanished((paths) => {
      const path = editorRef.current.path;
      if (path === null || !paths.includes(path)) return;
      // Its tab stays while this finds out where it went (`useTrashedNote`).
      holdOpen(path);
      const epoch = workspaceGenerationRef.current.epoch;
      const run = openRun.current;
      const still = () =>
        live &&
        workspaceGenerationRef.current.epoch === epoch &&
        openRun.current === run &&
        editorRef.current.path === path &&
        renamingRef.current === null &&
        trashedRef.current?.path !== path;
      setTimeout(() => {
        if (!still()) return;
        void (async () => {
          let moved: string | null = null;
          try {
            const note = await readNote({ workspaceId, path });
            moved = note.path;
          } catch {
            if (!still()) return;
            const trashed = await lookUpTrashed(path);
            if (!still()) return;
            if (trashed === null) setNotice(MOVED_ELSEWHERE);
            else markTrashed({ ...trashed, path });
            return;
          }
          // Still at the same name: it came back, or the listing was briefly behind.
          if (!still() || moved === path) return;
          followRename(path, moved);
        })();
      }, FOLLOW_DELAY_MS);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [workspaceId, subscribeVanished, readNote, followRename, holdOpen, lookUpTrashed, markTrashed]);
}
