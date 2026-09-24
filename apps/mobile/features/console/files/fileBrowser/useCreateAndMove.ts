/**
 * Drawing a move before the bucket confirms it, queuing one offline, and
 * creating notes, drawings and folders.
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
import { isDrawingPath, newDrawing } from "@context/drawings";
import { useCallback, useRef } from "react";
import {
  baseName,
  describeMoveProblem,
  describeNameProblem,
  displayName,
  ensureMarkdown,
  isMarkdown,
  joinPath,
  parentPath,
} from "../paths";
import { findEntry, namesIn } from "../tree";
import { untitledName } from "../untitled";
import {
  applyFolderCreate,
  applyMove,
  rekeyPath,
  rekeyPaths,
  subtreeOf,
  undoFolderCreate,
} from "../optimistic";
import {
  DRAWING_NEEDS_CONNECTION,
  FOLDER_NEEDS_CONNECTION,
  NOT_ON_DEVICE,
  claimedMessage,
  collision,
  folderLabel,
} from "./copy";
import type { Listings, FileBrowserOptions } from "./types";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { ListingsValues } from "./useListings";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { OpenNoteValues } from "./useOpenNote";
import type { QueuedOpsValues } from "./useQueuedOps";
import type { RunOperationValues } from "./useRunOperation";

type CreateAndMoveDeps =
  & { options: FileBrowserOptions }
  & Pick<FileActionsValues, "createDirectory" | "moveEntry" | "workspaceId" | "writeNote">
  & Pick<
    BrowserStateValues,
    | "autosave"
    | "dispatch"
    | "drawLocally"
    | "nextToastId"
    | "selectedPathRef"
    | "setExpanded"
    | "setNotice"
    | "setSelectedPath"
    | "setToasts"
  >
  & Pick<OfflineQueueValues, "listings" | "listingsRef" | "offlineRef">
  & Pick<ListingsValues, "refresh" | "reportRefreshFailure">
  & Pick<OpenNoteValues, "select">
  & Pick<RunOperationValues, "run">
  & Pick<QueuedOpsValues, "deviceEtag" | "isFolderPath" | "queuedToast" | "viaQueue">;

export function useCreateAndMove(deps: CreateAndMoveDeps) {
  const {
    options, autosave, createDirectory, deviceEtag, dispatch, drawLocally, isFolderPath, listings,
    listingsRef, moveEntry, nextToastId, offlineRef, queuedToast, refresh, reportRefreshFailure,
    run, select, selectedPathRef, setExpanded, setNotice, setSelectedPath, setToasts, viaQueue,
    workspaceId, writeNote,
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
        if (followed) select(to);
        queuedToast(`${message} Waiting to sync.`, queued.undo, () => {
          if (selectedPathRef.current === to) select(path);
        });
      })();
    },
    [autosave, deviceEtag, isFolderPath, options.canEdit, queuedToast, select],
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

  const createNote = useCallback(
    (folder: string, rawName: string) => {
      const name = ensureMarkdown(rawName);
      const problem = describeNameProblem(name) ?? collision(listings, folder, name);
      if (problem !== null) return setNotice(problem);
      const path = joinPath(folder, name);
      /*
        Offline, the note is made on the device and opened at once — the core
        of taking notes offline. It is a queued create (`baseEtag: null`), so
        what is eventually sent is the same `writeNote` with no `expectedEtag`
        this function makes online, and the server's create refuses if a note
        appeared at that name meanwhile: parked as a conflict, with nothing
        overwritten. The name checks above are the same ones, against the
        listings as drawn — the queue's own new notes included.
      */
      if (offlineRef.current.reachability === "offline") {
        if (!options.canEdit || workspaceId === null) return;
        if (isDrawingPath(name)) return setNotice(DRAWING_NEEDS_CONNECTION);
        if (offlineRef.current.claims(path)) return setNotice(claimedMessage(displayName(name)));
        const text = `# ${name.replace(/\.md$/i, "")}\n\n`;
        offlineRef.current.queueSave({ path, text, baseEtag: null });
        setExpanded((current) => (folder === "" ? current : new Set([...current, folder])));
        select(path);
        return;
      }
      void run(async () => {
        /*
          A drawing is seeded as a drawing, whichever control got here.

          `# name` is right for a note and is a file the gateway *refuses* on a
          `.excalidraw.md` path — `toolWriteNote` demands that a write to one
          carry a payload, so a person who typed `plan.excalidraw` into New
          note used to get an error rather than a drawing. Branching on the
          name rather than adding a second write path means every surface that
          creates a note gets this: the toolbar, the phone's `+`, and a folder
          row's menu.
        */
        const text = isDrawingPath(name) ? newDrawing() : `# ${name.replace(/\.md$/i, "")}\n\n`;
        await writeNote({ workspaceId: workspaceId!, path, text });
        return { touched: [path] };
      }).then((ok) => {
        if (ok) select(path);
      });
    },
    [listings, options.canEdit, run, select, workspaceId, writeNote],
  );

  /**
   * New drawing: the same creation as above, with the suffix supplied.
   *
   * A person names a diagram, not a file format, and `<name>.excalidraw.md` is
   * two extensions they should not have to know about. Delegating rather than
   * writing means the collision and name checks are the note's, once.
   */
  const createDrawing = useCallback(
    (folder: string, rawName: string) => {
      const trimmed = rawName.trim();
      createNote(folder, isDrawingPath(ensureMarkdown(trimmed)) ? trimmed : `${trimmed}.excalidraw`);
    },
    [createNote],
  );

  /**
   * The notes made without a name that have not taken one yet.
   *
   * Session-scoped and deliberately not derived from the *name* alone. A path
   * matching `untitled-<date>` is not enough to earn an automatic rename: a
   * note made yesterday, opened today, whose heading somebody had already
   * changed by hand would rename itself the moment it loaded — a file moving in
   * somebody's bucket because they looked at it. Only a note this session
   * created without asking for a name is a note this session may name.
   *
   * An entry leaves when the rename fires, so the adoption happens **once**.
   * After that the heading and the filename are two things the person owns
   * separately, which is how every other note in the bucket already works.
   */
  const awaitingTitle = useRef<Set<string>>(new Set());

  /**
   * New note, new drawing: made now, called `untitled-<date>`, opened.
   *
   * Delegates rather than writing, so the name checks, the collision check, the
   * offline queue and the drawing seed are all `createNote`'s — one create in
   * this file, whatever asked for it. What is added here is the name and the
   * promise that the name is temporary. See `untitled.ts`.
   */
  const createUntitled = useCallback(
    (folder: string, kind: "note" | "drawing") => {
      if (!options.canEdit) return;
      const make = (known: Listings) => {
        const name = untitledName(known, folder, kind, new Date());
        awaitingTitle.current.add(joinPath(folder, name));
        createNote(folder, name);
      };
      /*
        THE DESTINATION IS LOADED FIRST, AND THAT IS NOT A TIDINESS POINT.

        The name is chosen against the folder's listing, and listings are fetched
        per folder — so a destination nobody has opened reads as *empty*, and
        every untitled note made into it is called `untitled-<date>` with no
        suffix. The second one is then a name the bucket already has, and the
        server's create refuses it.

        That is not hypothetical: the quick-note link (`?quickAction=note`) files
        into `0-inbox` from a widget, on a console that has loaded the root and
        nothing else. Two captures on one day, in two launches, is the ordinary
        use of a capture widget — and before this the second was an error
        message.

        Loaded, this is one `listFiles` the console was going to make anyway when
        the create's own `refresh` ran. Unloaded and unreachable, the refusal
        surfaces through `reportRefreshFailure` rather than as a note that
        silently did not appear.
      */
      if (listings[folder] !== undefined) return make(listings);
      void refresh([folder])
        .then(({ pages }) => make({ ...listingsRef.current, ...pages }))
        .catch(reportRefreshFailure);
    },
    [createNote, listings, options.canEdit, refresh, reportRefreshFailure],
  );

  const createFolder = useCallback(
    (folder: string, name: string) => {
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
          return { touched: [path, joinPath(path, "README.md")] };
        },
        () => drawLocally((current) => undoFolderCreate(current, path)),
      );
      setExpanded((current) => new Set([...current, path]));
    },
    [createDirectory, drawLocally, listings, options.canEdit, queuedToast, run, workspaceId],
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
      const undoDraw = drawMove(path, to);
      void run(async () => {
        await moveEntry({ workspaceId: workspaceId!, from: path, to });
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
            const undoUndo = drawMove(to, path);
            void run(
              async () => {
                await moveEntry({ workspaceId: workspaceId!, from: to, to: path });
                return { ...back, message: `Moved back to ${folderLabel(from)}.` };
              },
              undoUndo,
            );
          },
        };
      }, undoDraw);
    },
    [drawMove, listings, moveEntry, moveResult, queueMoveOf, run, viaQueue, workspaceId],
  );

  return {
    drawListingMove, drawMove, moveResult, queueMoveOf, queueRemovalOf, createNote, createDrawing,
    awaitingTitle, createUntitled, createFolder, move,
  };
}

export type CreateAndMoveValues = ReturnType<typeof useCreateAndMove>;
