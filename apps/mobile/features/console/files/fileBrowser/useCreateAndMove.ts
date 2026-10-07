/**
 * Drawing a move before the bucket confirms it, queuing one offline, and
 * creating folders. Notes and drawings are `useNoteCreate`'s.
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
import { useCallback } from "react";
import {
  baseName,
  describeMoveProblem,
  describeNameProblem,
  displayName,
  isMarkdown,
  joinPath,
  parentPath,
} from "../paths";
import { findEntry, namesIn } from "../tree";
import { announceDid } from "../../map/live/announce";
import {
  applyFolderCreate,
  applyMove,
  rekeyPath,
  rekeyPaths,
  subtreeOf,
  undoFolderCreate,
} from "../optimistic";
import {
  FOLDER_NEEDS_CONNECTION,
  NOT_ON_DEVICE,
  claimedMessage,
  collision,
  folderLabel,
} from "./copy";
import type { FileBrowserOptions } from "./types";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { OpenNoteValues } from "./useOpenNote";
import type { QueuedOpsValues } from "./useQueuedOps";
import type { RunOperationValues } from "./useRunOperation";

type CreateAndMoveDeps =
  & { options: FileBrowserOptions }
  & Pick<FileActionsValues, "createDirectory" | "moveEntry" | "undoNewFolder" | "workspaceId">
  & Pick<
    BrowserStateValues,
    | "autosave"
    | "dispatch"
    | "drawLocally"
    | "nextToastId"
    | "noteRenamed"
    | "selectedPathRef"
    | "setExpanded"
    | "setNotice"
    | "setSelectedPath"
    | "setToasts"
  >
  & Pick<OfflineQueueValues, "listings" | "listingsRef" | "offlineRef">
  & Pick<OpenNoteValues, "select">
  & Pick<RunOperationValues, "run">
  & Pick<QueuedOpsValues, "deviceEtag" | "isFolderPath" | "queuedToast" | "viaQueue">;

export function useCreateAndMove(deps: CreateAndMoveDeps) {
  const {
    options, autosave, createDirectory, deviceEtag, dispatch, drawLocally, isFolderPath, listings,
    listingsRef, moveEntry, nextToastId, noteRenamed, offlineRef, queuedToast,
    run, select, selectedPathRef, setExpanded, setNotice, setSelectedPath, setToasts, undoNewFolder, viaQueue,
    workspaceId,
  } = deps;

  /* ------------------------------------------------------------------ */
  /*                     drawing it before sending it                    */
  /* ------------------------------------------------------------------ */

  /**
   * Move a row on screen now, and hand back the undo `run` needs.
   *
   * The complaint this answers is in `optimistic.ts`: a rename or a drag used
   * to await `moveEntry` and then a `listFiles` per touched folder before one
   * pixel changed, and for a folder it then collapsed the subtree, because the
   * listings under it were still keyed at a path the bucket no longer had.
   *
   * Three things move together, and they have to be one function or they come
   * apart: the listings, the set of expanded folders, and the selection. The
   * middle one is the whole of "the tree does not collapse" — `expanded` names
   * paths, so a folder renamed without re-keying it is a folder that was open
   * and is now shut.
   *
   * The selection is deliberately *closed* rather than followed when it is
   * inside what moved. Following it means reading the note again at its new
   * path, and `move` has always closed the editor for the folder it was given;
   * a note three levels down is the same event and gets the same answer. An
   * open tab left pointing at a path the bucket no longer has is the bug this
   * replaces, not the behaviour it keeps.
   */
  const drawListingMove = useCallback(
    (from: string, to: string): (() => void) => {
      drawLocally((current) => applyMove(current, from, to));
      setExpanded((current) => rekeyPaths(current, from, to));
      return () => {
        drawLocally((current) => applyMove(current, to, from));
        setExpanded((current) => rekeyPaths(current, to, from));
      };
    },
    [drawLocally],
  );

  /** `drawListingMove`, and the selection closed if it travelled with it. */
  const drawMove = useCallback(
    (from: string, to: string): (() => void) => {
      const undo = drawListingMove(from, to);
      const selected = selectedPathRef.current;
      if (selected !== null && rekeyPath(selected, from, to) !== selected) {
        setSelectedPath(null);
        dispatch({ type: "closed" });
      }
      return undo;
    },
    [drawListingMove],
  );

  /**
   * Which folders a move has to reload, and whether its subtree cascades.
   *
   * A note touches two folders and nothing else. A **folder** carries every
   * path beneath it into a different place in `privacy.md`, so the defaults
   * its contents inherit can change — and `applyMove` deliberately does not
   * recompute those, because guessing a visibility is how a console comes to
   * tell somebody a shared note is private. The re-keyed subtree is what makes
   * the screen right *now*; `cascadeFrom` is what makes it true, folder by
   * folder, as `refresh` commits each page.
   */
  const moveResult = useCallback((from: string, to: string) => {
    /*
      `listingsRef` and not the closed-over `listings`, and the call site has
      to make it **before** `drawMove` — the drawing re-keys the subtree, and a
      verdict taken after it would find nothing under `from` and quietly skip
      the cascade. That is exactly what an *undo* does, which is the path this
      was wrong on: moving a folder back left its contents drawn with the
      visibility the destination gave them.
    */
    const loaded = listingsRef.current;
    const known = findEntry(loaded, from);
    const isFolder = known === null ? !isMarkdown(from) : known.kind === "folder";
    return isFolder && subtreeOf(loaded, from).length > 0
      ? { touched: [from, to], cascadeFrom: to }
      : { touched: [from, to] };
  }, []);

  /**
   * Rename or move a note through the queue. Shared by `rename` and `move`,
   * which differ only in where the note ends up and what the toast says.
   */
  const queueMoveOf = useCallback(
    (path: string, to: string, message: string) => {
      if (!options.canEdit) return;
      const offline = offlineRef.current;
      if (isFolderPath(path)) return setNotice(FOLDER_NEEDS_CONNECTION);
      if (offline.claims(to) && offline.serverPathOf(path) !== to) {
        return setNotice(claimedMessage(displayName(baseName(to))));
      }
      void (async () => {
        // Anything the timer is holding for this note is queued first, under
        // the name the bucket knows — so it is sent ahead of the rename.
        autosave.flush(path);
        const etag = await deviceEtag(path);
        const queued = offlineRef.current.queueMove({ from: path, to, etag });
        if (!queued.ok) {
          setNotice(etag === null ? NOT_ON_DEVICE : claimedMessage(displayName(baseName(to))));
          return;
        }
        const followed = selectedPathRef.current === path;
        // Its tab follows it — see `FileBrowser.renamed` — before the editor
        // does, so the strip never holds a tab for a path nothing has.
        noteRenamed(path, to);
        if (followed) select(to);
        queuedToast(`${message} Waiting to sync.`, queued.undo, () => {
          noteRenamed(to, path);
          if (selectedPathRef.current === to) select(path);
        });
      })();
    },
    [autosave, deviceEtag, isFolderPath, noteRenamed, options.canEdit, queuedToast, select],
  );

  /** Delete (to the trash) or archive a note through the queue. */
  const queueRemovalOf = useCallback(
    (path: string, kind: "trash" | "archive") => {
      if (!options.canEdit) return;
      if (isFolderPath(path)) return setNotice(FOLDER_NEEDS_CONNECTION);
      void (async () => {
        autosave.flush(path);
        const etag = await deviceEtag(path);
        const queued = offlineRef.current.queueRemoval({ kind, path, etag });
        if (!queued.ok) {
          setNotice(etag === null ? NOT_ON_DEVICE : claimedMessage(displayName(baseName(path))));
          return;
        }
        if (selectedPathRef.current === path) {
          setSelectedPath(null);
          dispatch({ type: "closed" });
        }
        const name = displayName(baseName(path));
        const dropped = queued.dropped;
        if (dropped !== undefined) {
          /*
            A note created here and deleted before it was sent: nothing reaches
            the bucket, and its text is gone from the device. The undo is the
            only way back, so it is offered — putting the create back exactly as
            it was, unless something has taken the name since.
          */
          nextToastId.current += 1;
          setToasts([
            {
              id: `queued-${nextToastId.current}`,
              message: `Deleted ${name}. It had not synced, so nothing was sent.`,
              undo: () => offlineRef.current.restoreCreate(dropped),
            },
          ]);
          return;
        }
        queuedToast(
          kind === "trash" ? `Deleted ${name}. Waiting to sync.` : `Archived ${name}. Waiting to sync.`,
          queued.undo,
        );
      })();
    },
    [autosave, deviceEtag, isFolderPath, options.canEdit, queuedToast],
  );

  const createFolder = useCallback(
    (folder: string, name: string, how?: { open?: boolean }) => {
      const problem = describeNameProblem(name) ?? collision(listings, folder, name);
      if (problem !== null) return setNotice(problem);
      const path = joinPath(folder, name);
      if (offlineRef.current.reachability === "offline") {
        /*
          The server makes a folder real by writing its README placeholder,
          and this is that same call made later (`queueFolder`). Drawn now, as
          an empty folder, so a note can be made in it straight away.
        */
        if (!options.canEdit || workspaceId === null) return;
        if (offlineRef.current.claims(path)) return setNotice(claimedMessage(name));
        const queued = offlineRef.current.queueFolder(path);
        if (!queued.ok) return setNotice(claimedMessage(name));
        setExpanded((current) => new Set([...current, path]));
        queuedToast(`New folder ${folderLabel(name)}. Waiting to sync.`, queued.undo);
        return;
      }
      /*
        Drawn before it is sent, like a move — see `optimistic.ts`. A new
        folder used to appear only after `createDirectory` and the two listing
        reads that followed it, so pressing "New folder" and typing a name got
        you an unchanged tree and then, a beat later, a folder. The offline arm
        above has always drawn it immediately (`queueFolder`, through
        `overlay.ts`); this is the online arm finally doing the same thing.
      */
      drawLocally((current) => applyFolderCreate(current, path));
      void run(
        async () => {
          await createDirectory({ workspaceId: workspaceId!, path });
          return {
            touched: [path, joinPath(path, "README.md")],
            message: folder === "" ? `Created ${folderLabel(name)}.` : `Created ${folderLabel(name)} in ${folderLabel(folder)}.`,
            /*
              Undo takes it back while it is still empty (board 05c). The
              server decides "empty" against the whole bucket, notes this
              person cannot see included (`removeNewFolder`), and refuses with
              a sentence otherwise; `run` puts that sentence on the notice line
              and the redraw below is taken back, so the folder stays.
            */
            undo: () => {
              const inside = (at: string | null) => at !== null && (at === path || at.startsWith(`${path}/`));
              const wasOpen = inside(selectedPathRef.current);
              drawLocally((current) => undoFolderCreate(current, path));
              void run(
                async () => {
                  await undoNewFolder({ workspaceId: workspaceId!, path });
                  return { touched: [path, folder] };
                },
                () => drawLocally((current) => applyFolderCreate(current, path)),
              ).then((ok) => {
                if (ok && wasOpen && inside(selectedPathRef.current)) select(folder);
              });
            },
          };
        },
        () => drawLocally((current) => undoFolderCreate(current, path)),
      ).then((ok) => {
        if (ok && how?.open === true) select(path);
      });
      setExpanded((current) => new Set([...current, path]));
    },
    [createDirectory, drawLocally, listings, options.canEdit, queuedToast, run, select, undoNewFolder, workspaceId],
  );

  const move = useCallback(
    (path: string, destinationFolder: string) => {
      const problem = describeMoveProblem(
        path,
        destinationFolder,
        namesIn(listings, destinationFolder),
      );
      if (problem !== null) return setNotice(problem);
      const to = joinPath(destinationFolder, path.slice(path.lastIndexOf("/") + 1));
      const from = parentPath(path);
      if (viaQueue(path)) return queueMoveOf(path, to, `Moved to ${folderLabel(destinationFolder)}.`);
      const result = moveResult(path, to);
      /*
        The folder whose page is open follows it rather than closing: a
        phone's folder page offers Move to… for itself (board 08 of the Home
        artboards), and landing on Home after moving the folder you were
        looking at reads as the folder vanishing. A note open *inside* it
        still closes, for `drawMove`'s reason. `select` waits for the server.
      */
      const pageFollows = (from: string) => selectedPathRef.current === from && listings[from] !== undefined;
      const follows = pageFollows(path);
      const undoDraw = follows ? drawListingMove(path, to) : drawMove(path, to);
      void run(async () => {
        await moveEntry({ workspaceId: workspaceId!, from: path, to });
        // Drawn on the live map: a move made here reaches no tool call's record.
        announceDid(workspaceId ?? null, { kind: "move", from: path, to });
        return {
          ...result,
          message: `Moved to ${folderLabel(destinationFolder)}.`,
          // `moveEntry` is its own inverse — the same action with the ends
          // swapped — so this is the real operation and not a re-derivation of
          // it. It goes through `run` for the same reason the move did: a
          // failure has to reach the notice line, and the tree has to reload.
          undo: () => {
            // Verdict first — see `moveResult`.
            const back = moveResult(to, path);
            const followsBack = selectedPathRef.current === to;
            const undoUndo = followsBack ? drawListingMove(to, path) : drawMove(to, path);
            void run(
              async () => {
                await moveEntry({ workspaceId: workspaceId!, from: to, to: path });
                return { ...back, message: `Moved back to ${folderLabel(from)}.` };
              },
              undoUndo,
            ).then((ok) => {
              if (ok && followsBack && selectedPathRef.current === to) select(path);
            });
          },
        };
      }, undoDraw).then((ok) => {
        if (ok && follows && selectedPathRef.current === path) select(to);
      });
    },
    [drawListingMove, drawMove, listings, moveEntry, moveResult, queueMoveOf, run, select, viaQueue, workspaceId],
  );

  return {
    drawListingMove, drawMove, moveResult, queueMoveOf, queueRemovalOf, createFolder, move,
  };
}

export type CreateAndMoveValues = ReturnType<typeof useCreateAndMove>;
