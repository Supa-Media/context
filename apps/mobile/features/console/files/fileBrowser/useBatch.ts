/**
 * The multi-selection, run as one operation.
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
import { baseName, describeMoveProblem, parentPath, restoreTargetFor } from "../paths";
import { canDrop as planDrop } from "../dnd";
import { findEntry, namesIn } from "../tree";
import { countOf, folderLabel } from "./copy";
import type { BatchStep } from "./types";
import type { BrowserStateValues } from "./useBrowserState";
import type { CreateAndMoveValues } from "./useCreateAndMove";
import type { FileActionsValues } from "./useFileActions";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { QueuedOpsValues } from "./useQueuedOps";
import type { RowCommandsValues } from "./useRowCommands";
import type { RunOperationValues } from "./useRunOperation";

type BatchDeps =
  & Pick<
    FileActionsValues,
    | "archiveEntry"
    | "copyEntry"
    | "moveEntry"
    | "restoreTrashEntry"
    | "trashEntry"
    | "workspaceId"
  >
  & Pick<BrowserStateValues, "dispatch" | "selectedPathRef" | "setNotice" | "setSelectedPath">
  & Pick<OfflineQueueValues, "listings" | "offlineRef">
  & Pick<RunOperationValues, "run">
  & Pick<QueuedOpsValues, "viaQueue">
  & Pick<CreateAndMoveValues, "drawMove" | "move" | "moveResult">
  & Pick<RowCommandsValues, "archive" | "copyTo" | "destroy">;

export function useBatch(deps: BatchDeps) {
  const {
    archive, archiveEntry, copyEntry, copyTo, destroy, dispatch, drawMove, listings, move,
    moveEntry, moveResult, offlineRef, restoreTrashEntry, run, selectedPathRef, setNotice,
    setSelectedPath, trashEntry, viaQueue, workspaceId,
  } = deps;

  /* ------------------------------------------------------------------ */
  /*                    the multi-selection, as one operation             */
  /* ------------------------------------------------------------------ */

  /**
   * Whether a batch may go at all, said out loud when it may not.
   *
   * A path that routes through the offline queue is a note the bucket does not
   * have at that name yet, or any note while offline. The queue takes one
   * operation per note with its own toast and its own undo, and a batch built
   * from those would be five toasts that each replace the last — so a batch
   * that touches one refuses as a whole, before anything moves, and says how
   * to get the same result.
   */
  const batchRefused = useCallback(
    (paths: readonly string[]) => {
      if (!paths.some(viaQueue)) return false;
      setNotice(
        offlineRef.current.reachability === "offline"
          ? "Acting on several items at once needs a connection. Do them one at a time, or try again once you are back online."
          : "One of these has not reached your bucket yet. Do them one at a time, or try again once it has synced.",
      );
      return true;
    },
    [viaQueue],
  );

  /** Close the open note if it is one of `paths`, or inside one of them. */
  const closeIfWithin = useCallback((paths: readonly string[]) => {
    const open = selectedPathRef.current;
    if (open === null) return;
    if (!paths.some((path) => open === path || open.startsWith(`${path}/`))) return;
    setSelectedPath(null);
    dispatch({ type: "closed" });
  }, []);

  /**
   * One `run` for a batch of single-path steps. See `moveMany` in
   * `browser.ts` for why this is not a loop over the single-path methods.
   *
   * Each step does its one server call and hands back what it touched and how
   * to invert it. The steps go in order, and the first failure stops the
   * batch:
   *
   *  - **Nothing went** — the failure is thrown on, and `run` treats it like
   *    any single operation that failed, `revert` included.
   *  - **Some went** — that is not a failure, and reporting it as one would
   *    invite a retry of the ones that already moved. It is a notice that says
   *    how many went and why the next did not, and no Undo: a half-done batch
   *    is exactly what `run` reserves the notice for, and an undo offered for
   *    the part of it that happened reads as an undo of the whole. The rows
   *    drawn for the steps that never ran are put back here, because `run`
   *    only reverts a thrown failure.
   */
  const runBatch = useCallback(
    (
      steps: readonly BatchStep[],
      words: {
        done: (count: number) => string;
        undone: (count: number) => string;
      },
      options: {
        drawn?: readonly (() => void)[];
        /** Folders whose subtree is stale once the batch lands — see `moveResult`. */
        cascadeFrom?: readonly string[];
        /** The same, for the Undo: the folders as they are once moved back. */
        undoCascadeFrom?: readonly string[];
      } = {},
    ) => {
      const drawn = options.drawn ?? [];
      const revertFrom = (index: number) => {
        for (const revert of drawn.slice(index).reverse()) revert();
      };
      void run(
        async () => {
          const touched: string[] = [];
          const inverses: (() => Promise<unknown>)[] = [];
          for (const [index, step] of steps.entries()) {
            try {
              const done = await step.work();
              touched.push(...done.touched);
              inverses.push(done.undo);
            } catch (error) {
              if (index === 0) throw error;
              revertFrom(index);
              return {
                touched,
                message: `${words.done(index)} ${step.name} did not: ${toFileError(error).message}`,
                ...(options.cascadeFrom === undefined
                  ? {}
                  : { cascadeFrom: options.cascadeFrom.slice(0, index) }),
              };
            }
          }
          return {
            touched,
            message: words.done(steps.length),
            ...(options.cascadeFrom === undefined ? {} : { cascadeFrom: options.cascadeFrom }),
            undo: () => {
              void run(async () => {
                // Last first, so a batch whose steps depend on one another —
                // a later one landing where an earlier one left — unwinds in
                // the order that makes each inverse valid.
                for (const inverse of [...inverses].reverse()) await inverse();
                return {
                  touched,
                  message: words.undone(steps.length),
                  ...(options.undoCascadeFrom === undefined
                    ? {}
                    : { cascadeFrom: options.undoCascadeFrom }),
                };
              });
            },
          };
        },
        () => revertFrom(0),
      );
    },
    [run],
  );

  const moveMany = useCallback(
    (picked: readonly string[], destinationFolder: string) => {
      // What is already in the destination stays put — a batch from two
      // folders into one of them is a move of the rest, not a refusal. All of
      // it already there falls through to the single move's own refusal.
      const elsewhere = picked.filter((path) => parentPath(path) !== destinationFolder);
      const paths = elsewhere.length === 0 ? picked : elsewhere;
      if (paths.length === 1) return move(paths[0]!, destinationFolder);
      if (paths.length === 0 || batchRefused(paths)) return;
      // `dnd.ts`'s rules, which are already the multi-path ones: all or
      // nothing, and two picked `notes.md` cannot both land in one folder.
      const plan = planDrop(
        { paths, readOnly: paths.some((path) => findEntry(listings, path)?.readOnly === true) },
        { kind: "folder", path: destinationFolder },
        [],
        listings,
      );
      if (!plan.ok) return setNotice(plan.reason);
      // Verdicts before drawings — see `moveResult`.
      const results = plan.moves.map((step) => moveResult(step.from, step.to));
      const drawn = plan.moves.map((step) => drawMove(step.from, step.to));
      const where = folderLabel(destinationFolder);
      runBatch(
        plan.moves.map((step) => ({
          name: folderLabel(baseName(step.from)),
          work: async () => {
            await moveEntry({ workspaceId: workspaceId!, from: step.from, to: step.to });
            return {
              touched: [step.from, step.to],
              undo: () => moveEntry({ workspaceId: workspaceId!, from: step.to, to: step.from }),
            };
          },
        })),
        {
          done: (count) => `Moved ${countOf(count)} to ${where}.`,
          undone: (count) => `Moved ${countOf(count)} back.`,
        },
        {
          drawn,
          cascadeFrom: results.flatMap((result) =>
            result.cascadeFrom === undefined ? [] : [result.cascadeFrom],
          ),
          // A folder moved back carries its subtree back under the other
          // folder's rules, exactly as it did on the way out.
          undoCascadeFrom: results.flatMap((result) =>
            result.cascadeFrom === undefined ? [] : [result.touched[0]!],
          ),
        },
      );
    },
    [batchRefused, drawMove, listings, move, moveEntry, moveResult, runBatch, workspaceId],
  );

  const copyManyTo = useCallback(
    (paths: readonly string[], destinationFolder: string) => {
      if (paths.length === 1) return copyTo(paths[0]!, destinationFolder);
      if (paths.length === 0) return;
      // Copies take the next free "… copy" name rather than refusing a
      // collision, and `dnd.ts` plans those names across the whole batch.
      const plan = planDrop(
        { paths, readOnly: paths.some((path) => findEntry(listings, path)?.readOnly === true) },
        { kind: "folder", path: destinationFolder },
        ["copy"],
        listings,
      );
      if (!plan.ok) return setNotice(plan.reason);
      const where = folderLabel(destinationFolder);
      runBatch(
        plan.moves.map((step) => ({
          name: folderLabel(baseName(step.from)),
          work: async () => {
            await copyEntry({ workspaceId: workspaceId!, from: step.from, to: step.to });
            return {
              touched: [step.to],
              // A copy's inverse is putting the copy in the trash, which is
              // itself recoverable — the same way the single path is undone.
              undo: () => trashEntry({ workspaceId: workspaceId!, path: step.to }),
            };
          },
        })),
        {
          done: (count) => `Copied ${countOf(count)} to ${where}.`,
          undone: (count) =>
            count === 1 ? "Moved the copy to trash." : `Moved the ${count} copies to trash.`,
        },
      );
    },
    [copyEntry, copyTo, listings, runBatch, trashEntry, workspaceId],
  );

  const archiveMany = useCallback(
    (paths: readonly string[]) => {
      if (paths.length === 1) return archive(paths[0]!);
      if (paths.length === 0 || batchRefused(paths)) return;
      runBatch(
        paths.map((path) => ({
          name: folderLabel(baseName(path)),
          work: async () => {
            const result = await archiveEntry({ workspaceId: workspaceId!, path });
            return {
              touched: [path, result.to],
              undo: () => moveEntry({ workspaceId: workspaceId!, from: result.to, to: path }),
            };
          },
        })),
        {
          done: (count) => `Archived ${countOf(count)}.`,
          undone: (count) => `Restored ${countOf(count)}.`,
        },
      );
      closeIfWithin(paths);
    },
    [archive, archiveEntry, batchRefused, closeIfWithin, moveEntry, runBatch, workspaceId],
  );

  const restoreMany = useCallback(
    (paths: readonly string[]) => {
      const steps = paths.flatMap((path) => {
        const original = restoreTargetFor(path);
        return original === null ? [] : [{ from: path, to: original }];
      });
      // All or nothing, like every batch: a path with nowhere to go back to is
      // not quietly left in the archive while the rest leave it.
      if (steps.length !== paths.length || steps.length === 0) return;
      if (steps.length === 1) return move(steps[0]!.from, parentPath(steps[0]!.to));
      if (batchRefused(paths)) return;
      /*
        Each one checked against the folder it is going back to, grown as the
        plan is built — two archived `plan.md`s from the same folder cannot
        both go home, and a move never overwrites.
      */
      const taken = new Map<string, Set<string>>();
      for (const step of steps) {
        const folder = parentPath(step.to);
        const names = taken.get(folder) ?? new Set(namesIn(listings, folder));
        const problem = describeMoveProblem(step.from, folder, names);
        if (problem !== null) return setNotice(`${step.from}: ${problem}`);
        names.add(baseName(step.to));
        taken.set(folder, names);
      }
      const results = steps.map((step) => moveResult(step.from, step.to));
      const drawn = steps.map((step) => drawMove(step.from, step.to));
      runBatch(
        steps.map((step) => ({
          name: folderLabel(baseName(step.from)),
          work: async () => {
            await moveEntry({ workspaceId: workspaceId!, from: step.from, to: step.to });
            return {
              touched: [step.from, step.to],
              undo: () => moveEntry({ workspaceId: workspaceId!, from: step.to, to: step.from }),
            };
          },
        })),
        {
          done: (count) => `Restored ${countOf(count)}.`,
          undone: (count) => `Archived ${countOf(count)} again.`,
        },
        {
          drawn,
          cascadeFrom: results.flatMap((result) =>
            result.cascadeFrom === undefined ? [] : [result.cascadeFrom],
          ),
          // A folder moved back carries its subtree back under the other
          // folder's rules, exactly as it did on the way out.
          undoCascadeFrom: results.flatMap((result) =>
            result.cascadeFrom === undefined ? [] : [result.touched[0]!],
          ),
        },
      );
    },
    [batchRefused, drawMove, listings, move, moveEntry, moveResult, runBatch, workspaceId],
  );

  const destroyMany = useCallback(
    (paths: readonly string[]) => {
      if (paths.length === 1) return destroy(paths[0]!);
      if (paths.length === 0 || batchRefused(paths)) return;
      runBatch(
        paths.map((path) => ({
          name: folderLabel(baseName(path)),
          work: async () => {
            const result = await trashEntry({ workspaceId: workspaceId!, path });
            return {
              touched: [path, result.to],
              undo: () =>
                restoreTrashEntry({ workspaceId: workspaceId!, from: result.to, to: path }),
            };
          },
        })),
        {
          done: (count) => `Moved ${countOf(count)} to trash.`,
          undone: (count) => `Restored ${countOf(count)}.`,
        },
      );
      closeIfWithin(paths);
    },
    [batchRefused, closeIfWithin, destroy, restoreTrashEntry, runBatch, trashEntry, workspaceId],
  );

  return { moveMany, copyManyTo, archiveMany, restoreMany, destroyMany };
}

export type BatchValues = ReturnType<typeof useBatch>;
