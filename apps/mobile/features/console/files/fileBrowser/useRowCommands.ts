/**
 * One row's commands: rename, duplicate, download, archive, delete, paste and
 * copy.
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
import { toFileError } from "../browser";
import { type ReadResult, collectNotes, downloadNotice, pathsUnder } from "../download";
import { buildZip, downloadName } from "../zip";
import { saveFile } from "../saveFile";
import { afterPaste, planPaste, put } from "../clipboard";
import {
  baseName,
  describeNameProblem,
  displayName,
  ensureMarkdown,
  isMarkdown,
  joinPath,
  parentPath,
} from "../paths";
import { namesIn } from "../tree";
import { applyNoteCreate } from "../optimistic";
import { collision, folderLabel } from "./copy";
import type { BrowserStateValues } from "./useBrowserState";
import type { CreateAndMoveValues } from "./useCreateAndMove";
import type { FileActionsValues } from "./useFileActions";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { OpenNoteValues } from "./useOpenNote";
import type { QueuedOpsValues } from "./useQueuedOps";
import type { RunOperationValues } from "./useRunOperation";
import type { TrashedNoteValues } from "./useTrashedNote";

type RowCommandsDeps =
  & Pick<
    FileActionsValues,
    | "archiveEntry"
    | "copyEntry"
    | "duplicateEntry"
    | "moveEntry"
    | "notePathsAction"
    | "readNote"
    | "readNotesAction"
    | "restoreTrashEntry"
    | "trashEntry"
    | "workspaceId"
    | "workspaceGenerationRef"
    | "writeNote"
  >
  & Pick<
    BrowserStateValues,
    | "beginOnlineCreate"
    | "drawLocally"
    | "beginOnlineMove"
    | "pendingMoveTo"
    | "pendingCreateTo"
    | "autosave"
    | "clipboard"
    | "dispatch"
    | "editorRef"
    | "noteRenamed"
    | "renamingRef"
    | "selectedPath"
    | "selectedPathRef"
    | "setClipboard"
    | "setNotice"
    | "setSelectedPath"
  >
  & Pick<OfflineQueueValues, "listings">
  & Pick<OpenNoteValues, "followRename" | "select">
  & Pick<RunOperationValues, "run">
  & Pick<QueuedOpsValues, "viaQueue">
  & Pick<TrashedNoteValues, "clearTrashed" | "markTrashed" | "settleTrashed">
  & Pick<
    CreateAndMoveValues,
    | "drawListingMove"
    | "drawMove"
    | "moveResult"
    | "queueMoveOf"
    | "queueRemovalOf"
  >;

export function useRowCommands(deps: RowCommandsDeps) {
  const {
    archiveEntry, autosave, clipboard, copyEntry, dispatch, editorRef, drawListingMove, drawMove,
    duplicateEntry, followRename, listings, moveEntry, moveResult, notePathsAction, noteRenamed, queueMoveOf,
    queueRemovalOf, readNote, readNotesAction, renamingRef, restoreTrashEntry, run, select, selectedPath,
    setClipboard, setNotice, setSelectedPath, trashEntry, viaQueue, workspaceId,
    writeNote, beginOnlineMove, beginOnlineCreate, drawLocally, pendingMoveTo, pendingCreateTo, workspaceGenerationRef,
    clearTrashed, markTrashed, settleTrashed,
  } = deps;

  /**
   * A note's row drawn at its new name, and its tab told the same thing.
   *
   * The tab strip closes a tab whose note the loaded listing no longer holds,
   * and the listing moves on the press — so without this, renaming the open
   * note closed its tab, the last-tab rule closed the editor, and the page
   * went blank under the person renaming it. `noteRenamed` is what the strip
   * follows instead (`FileBrowser.renamed`); the revert says it again the other
   * way, so a refused rename puts the tab back where the row goes back.
   * A folder is left to the strip's own rule, as a move always has been.
   */
  const followed = useCallback(
    (from: string, to: string, revertDraw: () => void): (() => void) => {
      if (!isMarkdown(from)) return revertDraw;
      noteRenamed(from, to);
      return () => {
        revertDraw();
        noteRenamed(to, from);
      };
    },
    [noteRenamed],
  );

  /**
   * Text typed into a note while its rename was in flight, written to it after
   * the editor had already gone on to another one — the one case `followRename`
   * cannot carry. Conditional on the version just read, as every write is.
   */
  const writeHeld = useCallback(
    async (path: string, text: string) => {
      const epoch = workspaceGenerationRef.current.epoch;
      try {
        const note = await readNote({ workspaceId: workspaceId!, path });
        if (workspaceGenerationRef.current.epoch !== epoch || note.readOnly || note.encrypted === true || note.text === text) return;
        await writeNote({ workspaceId: workspaceId!, path, text, expectedEtag: note.etag });
      } catch {
        if (workspaceGenerationRef.current.epoch !== epoch) return;
        setNotice(`Some of what you typed in ${displayName(baseName(path))} could not be saved.`);
      }
    },
    [readNote, setNotice, workspaceId, workspaceGenerationRef, writeNote],
  );

  const rename = useCallback(
    (path: string, rawName: string) => {
      const folder = parentPath(path);
      const name = path.toLowerCase().endsWith(".md") ? ensureMarkdown(rawName) : rawName.trim();
      const problem = describeNameProblem(name) ?? collision(listings, folder, name);
      if (problem !== null) return setNotice(problem);
      const to = joinPath(folder, name);
      const was = baseName(path);
      if (viaQueue(path)) return queueMoveOf(path, to, `Renamed to ${displayName(name)}.`);
      if (pendingCreateTo(path) !== undefined) {
        setNotice("That note is still being created. Try again when it finishes.");
        return;
      }
      if (pendingMoveTo(path) !== undefined || renamingRef.current?.path === path) {
        setNotice("That rename is still being confirmed. Try again when it finishes.");
        return;
      }
      const epoch = workspaceGenerationRef.current.epoch;
      const currentContext = () => workspaceGenerationRef.current.epoch === epoch;
      // Forward and undo use exactly the same lifecycle, including the draft
      // hold, optimistic identity, refusal rollback and late completion.
      const perform = (from: string, destination: string, message: string, undoMessage?: string) => {
        if (!currentContext()) return;
        if (pendingMoveTo(from) !== undefined || renamingRef.current?.path === from) {
          setNotice("That rename is still being confirmed. Try again when it finishes.");
          return;
        }
        const result = moveResult(from, destination);
        const open = editorRef.current.path === from;
        const pending = beginOnlineMove(from, destination);
        const undoDraw = followed(from, destination, open ? drawListingMove(from, destination) : drawMove(from, destination));
        const hold = open ? {
          path: from,
          held: editorRef.current.draft !== editorRef.current.baseline ? editorRef.current.draft : null,
        } : null;
        if (hold !== null) renamingRef.current = hold;
        const settleDraft = (committed: boolean) => {
          if (!currentContext()) return;
          const held = hold?.held ?? null;
          if (renamingRef.current === hold) renamingRef.current = null;
          const stillOpen = editorRef.current.path === from;
          if (committed && stillOpen) {
            followRename(from, destination, undefined, writeHeld);
          } else if (stillOpen && editorRef.current.status === "dirty") {
            autosave.edited(from);
          } else if (!stillOpen && held !== null) {
            void writeHeld(committed ? destination : from, held);
          }
        };
        void run(async () => {
          // The heading follows the new name inside the move, on the server,
          // unless typing the move has to carry would be written under it
          // (`lib/fileOps/followHeading.ts`; a second write from here raced the
          // editor for the same line, 2026-10-14).
          await moveEntry({ workspaceId: workspaceId!, from, to: destination, followHeading: hold?.held == null });
          return {
            ...result, message,
            ...(undoMessage === undefined ? {} : {
              undo: () => perform(destination, from, undoMessage),
            }),
          };
        }, () => {
          if (pending.reject()) {
            undoDraw();
            settleDraft(false);
          } else if (renamingRef.current === hold) {
            renamingRef.current = null;
          }
        }, () => {
          if (pending.commit()) settleDraft(true);
          else if (renamingRef.current === hold) renamingRef.current = null;
        });
      };
      perform(path, to, `Renamed to ${displayName(name)}.`, `Renamed back to ${displayName(was)}.`);
    },
    [
      autosave,
      beginOnlineMove,
      pendingMoveTo,
      pendingCreateTo,
      workspaceGenerationRef,
      drawListingMove,
      drawMove,
      followRename,
      followed,
      writeHeld,
      listings,
      moveEntry,
      moveResult,
      queueMoveOf,
      run,
      select,
      selectedPath,
      viaQueue,
      workspaceId,
    ],
  );

  // An untitled note taking the title typed into it, and every linked note
  // after it, is `useLinkedTitle.ts`.

  const duplicate = useCallback(
    (path: string) => {
      let destination: string | undefined;
      void run(async () => {
        const result = await duplicateEntry({ workspaceId: workspaceId!, path });
        destination = result.to;
        return { touched: [path, result.to], message: `Duplicated as ${displayName(baseName(result.to))}.` };
      }, undefined, () => {
        if (destination === undefined || !isMarkdown(destination)) return;
        const to = destination;
        drawLocally((current) => applyNoteCreate(current, to));
        beginOnlineCreate(to).commit();
      });
    },
    [duplicateEntry, run, workspaceId, drawLocally, beginOnlineCreate],
  );

  /**
   * Put a note, or a whole folder, on the person's own disk.
   *
   * ## The last step of the exit, which was the one that was missing
   *
   * Non-negotiable #1 promises the customer can always leave with their
   * content and that the exit is never gated or degraded. Everything under
   * that was built — plain Markdown, a bucket they hold the key to, a
   * hand-off that survives cancellation — except the step somebody actually
   * takes. Getting your own writing out of the console meant opening the
   * bucket somewhere else, which asks a person to hold cloud credentials to
   * read what they wrote.
   *
   * ## Deliberately not behind `canEdit`
   *
   * Every other verb in this file goes through `run`, which refuses a
   * read-only console. This does not, and that is the point rather than an
   * oversight: downloading is a **read**, it asks the server nothing the row's
   * own Open does not, and gating the exit on write access would make it
   * exactly the degraded thing the non-negotiable forbids. A `member` in
   * somebody else's context downloads what they can see, and a note held back
   * is absent from the archive the same way it is absent from the listing —
   * `notePaths` and `readNotes` are both filtered by the live manifest.
   *
   * ## A folder is one archive, and a short one says so
   *
   * The fetching, its bound and what it does with a note it cannot read are in
   * `download.ts`, away from React, because the bound is the part a hand-test
   * never reaches. An archive that is quietly incomplete is the worst outcome
   * on this path — nobody finds out until the bucket is gone — so the count is
   * said out loud.
   */
  const download = useCallback(
    (path: string, kind: "file" | "folder") => {
      if (workspaceId === null) return;
      void (async () => {
        try {
          if (kind === "file") {
            const note = await readNote({ workspaceId, path });
            const saved = saveFile(
              downloadName(path, ".md"),
              new TextEncoder().encode(note.text),
              "text/markdown;charset=utf-8",
            );
            setNotice(
              saved
                ? downloadNotice("file", 1, 0)
                : "This device cannot save a file. Open the console in a browser to download.",
            );
            return;
          }

          const listed = await notePathsAction({ workspaceId });
          if (listed.paths === null) {
            // The walk did not reach the end, so an archive built from it
            // would be short with nothing saying so. Refused rather than
            // written — see the header.
            setNotice("That folder could not be listed to the end, so nothing was downloaded.");
            return;
          }
          const wanted = pathsUnder(listed.paths, path);
          // Said before the reads start, because a folder of two hundred notes
          // is several round trips and a control that does nothing visible for
          // four seconds reads as one that did nothing.
          setNotice(
            wanted.length === 1
              ? "Downloading 1 note…"
              : `Downloading ${wanted.length} notes…`,
          );
          const { entries, missed } = await collectNotes(wanted, async (batch) => {
            const answer = await readNotesAction({ workspaceId, paths: batch });
            return answer.results as readonly ReadResult[];
          });
          const saved = saveFile(
            downloadName(path, ".zip"),
            buildZip(entries),
            "application/zip",
          );
          setNotice(
            saved
              ? downloadNotice("folder", entries.length, missed.length)
              : "This device cannot save a file. Open the console in a browser to download.",
          );
        } catch (error) {
          setNotice(toFileError(error).message);
        }
      })();
    },
    [notePathsAction, readNote, readNotesAction, workspaceId],
  );

  const archive = useCallback(
    (path: string) => {
      if (viaQueue(path)) return queueRemovalOf(path, "archive");
      void run(async () => {
        const result = await archiveEntry({ workspaceId: workspaceId!, path });
        return {
          touched: [path, result.to],
          // Without its sort number, the way the row somebody just acted on
          // was drawn — that row is gone from the listing by the time they
          // read this. (`rename`'s own `was`, above, keeps the whole name on
          // disk: that message is the undo of a rename, so the name it will
          // put back is exactly the point.)
          message: `Archived ${folderLabel(baseName(path))}.`,
          // The inverse is a move, not an "unarchive": `archiveEntry` puts the
          // file under a timestamped folder in `4-archive/`, so the way back is
          // to move it out of there to where it was. `restoreTargetFor` reads
          // that original path back out and the row menu's Restore uses the
          // same function, so the two ways back cannot disagree.
          undo: () => {
            void run(async () => {
              await moveEntry({ workspaceId: workspaceId!, from: result.to, to: path });
              return {
                touched: [result.to, path],
                message: `Restored to ${folderLabel(parentPath(path))}.`,
              };
            });
          },
        };
      });
      if (selectedPath === path) {
        setSelectedPath(null);
        dispatch({ type: "closed" });
      }
    },
    [archiveEntry, moveEntry, queueRemovalOf, run, selectedPath, viaQueue, workspaceId],
  );

  const destroy = useCallback(
    (path: string) => {
      if (viaQueue(path)) return queueRemovalOf(path, "trash");
      /*
        The note on screen stays there, as a trashed note with Restore in
        Share's place (`useTrashedNote`), and that replaces the toast: the way
        back is on the page. Marked before the call, so the tab strip and the
        follow timer already know when the listing drops it.
      */
      const open = selectedPath === path && editorRef.current.path === path && isMarkdown(path);
      if (open) markTrashed({ path, trash: null, at: Date.now(), byYou: true, byName: null });
      void run(async () => {
        const result = await trashEntry({ workspaceId: workspaceId!, path });
        if (open) {
          settleTrashed(path, result.to);
          return { touched: [path, result.to] };
        }
        return {
          touched: [path, result.to],
          message: `Moved ${folderLabel(baseName(path))} to trash.`,
          undo: () => {
            void run(async () => {
              await restoreTrashEntry({
                workspaceId: workspaceId!,
                from: result.to,
                to: path,
              });
              return {
                touched: [result.to, path],
                message: `Restored to ${folderLabel(parentPath(path))}.`,
              };
            });
          },
        };
      }, open ? () => clearTrashed(path) : undefined);
      if (!open && selectedPath === path) {
        setSelectedPath(null);
        dispatch({ type: "closed" });
      }
    },
    [clearTrashed, markTrashed, queueRemovalOf, restoreTrashEntry, run, selectedPath, settleTrashed, trashEntry, viaQueue, workspaceId],
  );

  const paste = useCallback(
    (destinationFolder: string) => {
      const plan = planPaste(clipboard, destinationFolder, namesIn(listings, destinationFolder));
      if (!plan.ok) return setNotice(plan.reason);
      const held = clipboard!;
      void run(async () => {
        if (plan.action === "move") {
          await moveEntry({ workspaceId: workspaceId!, from: plan.from, to: plan.to });
        } else {
          await copyEntry({ workspaceId: workspaceId!, from: plan.from, to: plan.to });
        }
        return { touched: [plan.from, plan.to] };
      }).then((ok) => {
        if (ok) setClipboard(afterPaste(held));
      });
    },
    [clipboard, copyEntry, listings, moveEntry, run, workspaceId],
  );

  /**
   * A copy whose source is an argument, for the ⌥-drop on the tree.
   *
   * `paste` above is right for the toolbar and the menu, where the clipboard
   * *is* what the person chose. A drop is not that: what is being copied is
   * what is under the cursor, and the clipboard is somebody else's business.
   * The call site used to bridge the two with `copy(from)` then `paste(to)`,
   * which cannot work — `copy` sets state and `paste` reads the clipboard from
   * the render that created it, so in one tick the paste sees the clipboard as
   * it was *before* the drag. On an empty clipboard that refused and threw the
   * person's clipboard away; on a pending cut it moved an unrelated file into
   * the drop folder.
   *
   * So the source is passed in and a `Clipboard` value is built here to hand to
   * `planPaste` — the naming and collision rules stay in one place, because a
   * drop and a paste disagreeing about which "… copy" name something lands
   * under would be its own small betrayal. Nothing here reads or writes
   * `clipboard`, which is also why this callback does not depend on it.
   *
   * The plan is always a copy (the mode says so), so there is no `move` branch
   * to get wrong — but it can still be refused, by a folder dropped inside
   * itself, and that refusal is worth showing.
   */
  const copyTo = useCallback(
    (from: string, destinationFolder: string) => {
      const plan = planPaste(
        put("copy", from),
        destinationFolder,
        namesIn(listings, destinationFolder),
      );
      if (!plan.ok) return setNotice(plan.reason);
      void run(async () => {
        await copyEntry({ workspaceId: workspaceId!, from: plan.from, to: plan.to });
        return { touched: [plan.from, plan.to] };
      });
    },
    [copyEntry, listings, run, workspaceId],
  );

  return { rename, duplicate, download, archive, destroy, paste, copyTo };
}

export type RowCommandsValues = ReturnType<typeof useRowCommands>;
