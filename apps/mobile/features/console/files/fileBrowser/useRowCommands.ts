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
import { useCallback, useEffect } from "react";
import { toFileError } from "../browser";
import { type ReadResult, collectNotes, downloadNotice, pathsUnder } from "../download";
import { buildZip, downloadName } from "../zip";
import { saveFile } from "../saveFile";
import { afterPaste, planPaste, put } from "../clipboard";
import { baseName, describeNameProblem, ensureMarkdown, isMarkdown, joinPath, parentPath } from "../paths";
import { namesIn } from "../tree";
import { isUntitled, nameFromTitle } from "../untitled";
import { collision, folderLabel } from "./copy";
import type { BrowserStateValues } from "./useBrowserState";
import type { CreateAndMoveValues } from "./useCreateAndMove";
import type { FileActionsValues } from "./useFileActions";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { OpenNoteValues } from "./useOpenNote";
import type { QueuedOpsValues } from "./useQueuedOps";
import type { RunOperationValues } from "./useRunOperation";

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
  >
  & Pick<
    BrowserStateValues,
    | "clipboard"
    | "dispatch"
    | "editor"
    | "noteRenamed"
    | "selectedPath"
    | "selectedPathRef"
    | "setClipboard"
    | "setNotice"
    | "setSelectedPath"
  >
  & Pick<OfflineQueueValues, "listings">
  & Pick<OpenNoteValues, "select">
  & Pick<RunOperationValues, "run">
  & Pick<QueuedOpsValues, "viaQueue">
  & Pick<
    CreateAndMoveValues,
    | "awaitingTitle"
    | "drawListingMove"
    | "drawMove"
    | "moveResult"
    | "queueMoveOf"
    | "queueRemovalOf"
  >;

export function useRowCommands(deps: RowCommandsDeps) {
  const {
    archiveEntry, awaitingTitle, clipboard, copyEntry, dispatch, drawListingMove, drawMove,
    duplicateEntry, editor, listings, moveEntry, moveResult, notePathsAction, noteRenamed, queueMoveOf,
    queueRemovalOf, readNote, readNotesAction, restoreTrashEntry, run, select, selectedPath,
    selectedPathRef, setClipboard, setNotice, setSelectedPath, trashEntry, viaQueue, workspaceId,
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

  const rename = useCallback(
    (path: string, rawName: string) => {
      const folder = parentPath(path);
      const name = path.toLowerCase().endsWith(".md") ? ensureMarkdown(rawName) : rawName.trim();
      const problem = describeNameProblem(name) ?? collision(listings, folder, name);
      if (problem !== null) return setNotice(problem);
      const to = joinPath(folder, name);
      const was = baseName(path);
      if (viaQueue(path)) return queueMoveOf(path, to, `Renamed to ${name}.`);
      const result = moveResult(path, to);
      /*
        A rename of the OPEN note follows the editor rather than closing it,
        which is why `drawMove` is not used here and the listings are moved on
        their own. `drawMove` closes a selection that travelled — correct for a
        move, where you asked for the row to go somewhere else, and wrong for a
        rename, where you asked for the thing you are reading to be called
        something else and expect to go on reading it.

        Renaming a *folder* you have a note open inside is the move case and
        gets `drawMove`'s answer: the path changed under the editor and there
        is nothing sensible to keep it pointed at.
      */
      const renamedInPlace = selectedPath === path;
      const undoDraw = followed(
        path,
        to,
        renamedInPlace ? drawListingMove(path, to) : drawMove(path, to),
      );
      void run(async () => {
        await moveEntry({ workspaceId: workspaceId!, from: path, to });
        return {
          ...result,
          message: `Renamed to ${name}.`,
          undo: () => {
            // Verdict first — see `moveResult`.
            const backResult = moveResult(to, path);
            const open = selectedPathRef.current === to;
            const undoUndo = followed(to, path, open ? drawListingMove(to, path) : drawMove(to, path));
            void run(async () => {
              await moveEntry({ workspaceId: workspaceId!, from: to, to: path });
              return { ...backResult, message: `Renamed back to ${was}.` };
            }, undoUndo).then((ok) => {
              // The editor follows the file, in both directions. Without this
              // an undone rename left the open tab pointing at a path the
              // bucket no longer has.
              if (ok && selectedPathRef.current === to) select(path);
            });
          },
        };
      }, undoDraw).then((ok) => {
        /*
          The listing is renamed on the press; the *editor* is not, and this
          stays where it was — after the server said yes. `select` reads the
          note at its new path, and that path does not exist until `moveEntry`
          returns, so moving this earlier would fetch a 404 and close the note
          somebody is reading.
        */
        if (ok && renamedInPlace) select(to);
      });
    },
    [
      drawListingMove,
      drawMove,
      followed,
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

  /**
   * AN UNTITLED NOTE TAKES THE TITLE YOU TYPE INTO IT.
   *
   * The other half of not asking for a name up front. `createUntitled` makes
   * `untitled-2026-09-19.md` seeded with that same word as its heading; the
   * person types over the heading, and this renames the file to match.
   *
   * ## Why it runs on a settled editor and nowhere else
   *
   * `clean` and `saved` are the two states where nothing is in flight: the draft
   * is in the bucket, the etag the editor holds is the one the bucket answered
   * with, and the autosave timer is spent. (`saved` is `clean` wearing a chip
   * that decays — see `EditorStatus` — so excluding it would mean the rename
   * waited on a *UI* timer, which is how it went missing the first time this was
   * written.) Renaming at any other moment races the write: `performSave`
   * captures the path when it is called, and a `moveEntry` that lands in between
   * would leave a conditional write aimed at a name the bucket no longer has.
   * There is machinery for exactly that — `serverPathOf`, which sends the queued
   * write to the old name ahead of the rename — and the right use of it is as a
   * safety net for the offline case rather than as the normal path for every new
   * note in the product.
   *
   * A note created **offline** is `queued`, so it is not titled until its drain
   * lands and the editor settles. That is the honest order: the bucket does not
   * have the note yet, so there is nothing there to rename.
   *
   * It is a rename and not a second create, so it goes through `rename` — the
   * collision check, the toast with its undo, and the `select(to)` that keeps
   * the open editor pointing at the file are all that function's, once.
   *
   * ## What stops it running twice
   *
   * The path leaves `awaitingTitle` **before** the rename is asked for, so a
   * re-render during the move cannot start a second one, and a person who
   * rewrites the heading afterwards keeps the filename they were given. A
   * rename that is refused therefore costs the note its automatic title and
   * nothing else: the notice says why, and Rename is on the row menu.
   */
  useEffect(() => {
    const path = editor.path;
    if (path === null) return;
    if (editor.status !== "clean" && editor.status !== "saved") return;
    if (!awaitingTitle.current.has(path)) return;
    // Belt and braces with the set above: a name that is not one of ours is
    // never renamed, whatever the set says.
    if (!isUntitled(path)) {
      awaitingTitle.current.delete(path);
      return;
    }
    const name = nameFromTitle(path, editor.draft);
    if (name === null) return;
    awaitingTitle.current.delete(path);
    rename(path, name);
  }, [editor.draft, editor.path, editor.status, rename]);

  const duplicate = useCallback(
    (path: string) => {
      void run(async () => {
        const result = await duplicateEntry({ workspaceId: workspaceId!, path });
        return { touched: [path, result.to] };
      });
    },
    [duplicateEntry, run, workspaceId],
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
      void run(async () => {
        const result = await trashEntry({ workspaceId: workspaceId!, path });
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
      });
      if (selectedPath === path) {
        setSelectedPath(null);
        dispatch({ type: "closed" });
      }
    },
    [queueRemovalOf, restoreTrashEntry, run, selectedPath, trashEntry, viaQueue, workspaceId],
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
