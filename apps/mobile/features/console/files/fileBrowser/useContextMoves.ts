/**
 * Moving an entry into another context, and the moves already under way.
 *
 * Part of `useFileBrowser`, moved out of that file verbatim. The facade calls
 * each part in the order the code used to run, so every hook is still called
 * in the same order with the same dependency lists; what a part reads from an
 * earlier one arrives in `deps`, and is the same value the code closed over
 * before.
 */
/* eslint-disable react-hooks/exhaustive-deps -- Every dependency list in this
   file was moved unchanged from `useFileBrowser.ts`, where the rule accepted
   it. What it reports here is refs, state setters and `dispatch` that now
   arrive through `deps` instead of from a `useRef`, `useState` or `useReducer`
   in the same function, so the rule can no longer see they are stable. */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import type { ContextMoveProgress } from "../browser";
import { baseName, joinPath } from "../paths";
import { foldersToRefresh } from "../tree";
import type { FileBrowserOptions } from "./types";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { ListingsValues } from "./useListings";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { RunOperationValues } from "./useRunOperation";

type ContextMovesDeps =
  & { options: FileBrowserOptions }
  & Pick<
    FileActionsValues,
    | "dismissContextMoveMutation"
    | "folderPathsAction"
    | "resumeContextMoveAction"
    | "startContextMoveAction"
    | "workspaceId"
  >
  & Pick<BrowserStateValues, "dispatch" | "selectedPath" | "setNotice" | "setSelectedPath">
  & Pick<OfflineQueueValues, "listingsRef">
  & Pick<ListingsValues, "refresh">
  & Pick<RunOperationValues, "run">;

export function useContextMoves(deps: ContextMovesDeps) {
  const {
    options, dismissContextMoveMutation, dispatch, folderPathsAction, listingsRef, refresh,
    resumeContextMoveAction, run, selectedPath, setNotice, setSelectedPath, startContextMoveAction,
    workspaceId,
  } = deps;

  /* ------------------------------------------------------------------ */
  /*                     moving into another context                      */
  /* ------------------------------------------------------------------ */

  /**
   * Whose contexts this person may send something to.
   *
   * Gated on owning the context they are standing in, which is the *source*
   * half of the rule `functions/contextMoves.ts` enforces. The caller has
   * already filtered the list by what they may write at the far end.
   */
  const moveDestinations = useMemo(
    () =>
      options.isOwner === true
        ? (options.destinations ?? []).filter((destination) => destination.id !== workspaceId)
        : [],
    [options.destinations, options.isOwner, workspaceId],
  );

  const destinationFolders = useCallback(
    async (contextId: string) => {
      const answer = await folderPathsAction({ workspaceId: contextId as Id<"workspaces"> });
      return { folders: answer.folders, truncated: answer.truncated };
    },
    [folderPathsAction],
  );

  /**
   * The moves out of this context, as the dialog and the pane read them.
   *
   * Owner-only on the server too, so this subscribes only where the rail
   * already says they own it — a query that would be refused is a permanent
   * error state on every paint.
   */
  const moveRows = useQuery(
    api.functions.contextMoves.listContextMoves,
    options.isOwner === true && workspaceId !== null ? { workspaceId } : "skip",
  );

  const contextMoves: readonly ContextMoveProgress[] = useMemo(() => {
    const named = new Map((options.destinations ?? []).map((one) => [one.id, one.label]));
    return (moveRows ?? []).map((row) => ({
      id: row.moveId,
      from: row.from,
      to: row.to,
      // The id is a poor label and a deliberate one: a context this person can
      // no longer see must not have its name re-printed from a stale row.
      destination: named.get(row.destinationWorkspaceId) ?? row.destinationWorkspaceId,
      status: row.status,
      objects: row.movedObjects,
      skipped: row.skipped,
      ...(row.error === undefined ? {} : { error: row.error }),
    }));
  }, [moveRows, options.destinations]);

  /*
    A MOVE THAT FINISHED SOMEWHERE ELSE STILL HAS TO SHOW UP HERE.

    Every other operation reloads the tree inside `run`, because it is over by
    the time `run` returns. This one is not: the press starts a job, the last
    batch lands seconds or minutes later in a scheduled action, and nothing on
    this device is waiting on it. Without this the folder it came out of keeps
    drawing notes the bucket no longer has, until something else happens to
    reload it.

    Keyed on the transition rather than on the row, so a completed move sitting
    in the list for its day does not re-refresh on every paint.
  */
  const settledMoves = useRef(new Set<string>());
  useEffect(() => {
    const done = contextMoves.filter((move) => move.status !== "moving");
    const fresh = done.filter((move) => !settledMoves.current.has(move.id));
    for (const move of done) settledMoves.current.add(move.id);
    if (fresh.length === 0) return;
    for (const move of fresh) {
      // `cascadeFrom` as well as the parent, because what moved was often a
      // folder: its own listing and every loaded listing beneath it describe a
      // subtree that is not there any more. The parent alone takes the row out
      // of the tree and leaves those behind, which is the state a reopened
      // breadcrumb draws from.
      void refresh(
        foldersToRefresh([move.from], {
          cascadeFrom: move.from,
          loaded: Object.keys(listingsRef.current),
        }),
      );
    }
  }, [contextMoves, refresh]);

  const moveToContext = useCallback(
    (path: string, contextId: string, destinationFolder: string) => {
      const destination = moveDestinations.find((one) => one.id === contextId);
      if (destination === undefined) {
        return setNotice("You can only move things into a context you can write to.");
      }
      const to = joinPath(destinationFolder, baseName(path));
      void run(async () => {
        await startContextMoveAction({
          sourceWorkspaceId: workspaceId!,
          from: path,
          destinationWorkspaceId: contextId as Id<"workspaces">,
          to,
        });
        return {
          touched: [path],
          /*
            The present tense is the honest one. `startContextMove` returns as
            soon as the job exists; nothing has crossed yet, and a folder of a
            few thousand notes will still be crossing when this toast is gone.
            `contextMoves` is what says when it is done — and no `undo`,
            because the inverse of a move that is still running is not a move.
          */
          message: `Moving to ${destination.label}…`,
        };
      });
      if (selectedPath === path) {
        setSelectedPath(null);
        dispatch({ type: "closed" });
      }
    },
    [moveDestinations, run, selectedPath, startContextMoveAction, workspaceId],
  );

  const resumeContextMove = useCallback(
    (id: string) => {
      void run(async () => {
        await resumeContextMoveAction({ moveId: id as Id<"contextMoves"> });
        return { touched: [], message: "Picking the move back up…" };
      });
    },
    [resumeContextMoveAction, run],
  );

  /**
   * Record that the outcome has been read, so the row stops being listed.
   *
   * Outside `run`, unlike every other call here, because it touches no file
   * and has nothing to say: `run` exists to reload what an operation changed
   * and to put a sentence on the screen, and a toast reporting that a notice
   * was dismissed is the notice again. The pane hides the line on the press
   * from its own state; this is what makes that answer survive the launch.
   *
   * Swallowed on failure on `dismissStorageMigrationOffer`'s model — what a
   * lost write costs is seeing the line once more, and an error banner over a
   * dismissal is a worse version of the thing being dismissed.
   */
  const dismissContextMove = useCallback(
    (id: string) => {
      void dismissContextMoveMutation({ moveId: id as Id<"contextMoves"> }).catch(() => {});
    },
    [dismissContextMoveMutation],
  );

  return {
    moveDestinations, destinationFolders, contextMoves, moveToContext, resumeContextMove,
    dismissContextMove,
  };
}

export type ContextMovesValues = ReturnType<typeof useContextMoves>;
