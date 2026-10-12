import { useCallback, useEffect, useRef } from "react";
import { toFileError } from "../browser";
import { raceTimeout } from "../../storage/timeout";
import { foldersToRefresh } from "../tree";
import { NEEDS_CONNECTION, STALE_LISTING_MESSAGE, TIMED_OUT_MESSAGE } from "./copy";
import { OPERATION_TIMEOUT_MS } from "./timing";
import type { FileBrowserOptions } from "./types";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { ListingsValues } from "./useListings";
import type { OfflineQueueValues } from "./useOfflineQueue";

type OperationResult = {
  touched: string[];
  cascadeFrom?: string | readonly string[];
  message?: string;
  undo?: () => void;
};
type RunOperationDeps =
  & { options: FileBrowserOptions }
  & Pick<FileActionsValues, "workspaceId" | "workspaceGenerationRef">
  & Pick<BrowserStateValues, "nextToastId" | "operationRun" | "setBusy" | "setNotice" | "setToasts">
  & Pick<OfflineQueueValues, "listingsRef" | "offlineRef">
  & Pick<ListingsValues, "refresh">;

export const LISTING_REFRESH_TIMEOUT_MS = 10_000;

/**
 * Every mutation settles independently. Generations only arbitrate shared
 * chrome; they cannot turn a committed storage change into a failed rename.
 * A timeout releases the toolbar while its original promise remains watched.
 */
export function useRunOperation(deps: RunOperationDeps) {
  const {
    options, listingsRef, nextToastId, offlineRef, operationRun, refresh, setBusy, setNotice,
    setToasts, workspaceId, workspaceGenerationRef,
  } = deps;
  // Context identity alone cannot invalidate work when the whole browser is
  // unmounted. A lifetime generation also prevents Strict Mode's discarded
  // mount from reconciling into its replacement.
  const lifetime = useRef({ mounted: true, generation: 0 });
  useEffect(() => {
    const state = lifetime.current;
    state.mounted = true;
    return () => {
      state.mounted = false;
      state.generation += 1;
    };
  }, []);
  const epoch = workspaceGenerationRef.current.epoch;
  const run = useCallback(async (
    work: () => Promise<OperationResult>,
    revert?: () => void,
    onCommitted?: () => void,
  ): Promise<boolean> => {
    // Undo/toast callbacks may outlive the workspace that created them. They
    // must not issue storage mutations or undo drawings in its replacement.
    if (!lifetime.current.mounted || workspaceGenerationRef.current.epoch !== epoch) return false;
    if (!options.canEdit || workspaceId === null) {
      revert?.();
      return false;
    }
    if (offlineRef.current.reachability === "offline") {
      setToasts([]);
      setNotice(NEEDS_CONNECTION);
      revert?.();
      return false;
    }
    const generation = lifetime.current.generation;
    const currentContext = () => lifetime.current.mounted &&
      lifetime.current.generation === generation && workspaceGenerationRef.current.epoch === epoch;
    const mine = ++operationRun.current;
    const ownsChrome = () => currentContext() && operationRun.current === mine;
    setBusy(true);
    setNotice(null);
    setToasts([]);
    const working = (async () => await work())();
    let settled = await raceTimeout(working, {
      ms: OPERATION_TIMEOUT_MS,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (handle) => clearTimeout(handle),
    });
    if (!currentContext()) return false;
    if (settled.kind === "timeout") {
      if (ownsChrome()) {
        setBusy(false);
        setNotice(TIMED_OUT_MESSAGE);
      }
      // Unknown is not failure. Keep the caller's autosave hold and pending
      // overlay until this very operation eventually commits or rejects.
      settled = await working.then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
    }
    if (!currentContext()) return false;
    if (settled.kind === "failed") {
      revert?.();
      if (ownsChrome()) {
        setBusy(false);
        setNotice(toFileError(settled.error).message);
      }
      return false;
    }
    const result = settled.value;
    onCommitted?.();
    if (ownsChrome()) setBusy(false);
    // Follow editor identity on commit. Confirmation is bounded background
    // work, and its failure can only qualify the listing, never the mutation.
    void (async () => {
      const reloaded = await raceTimeout(refresh(foldersToRefresh(result.touched, {
        cascadeFrom: result.cascadeFrom,
        loaded: Object.keys(listingsRef.current),
      })), {
        ms: LISTING_REFRESH_TIMEOUT_MS,
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (handle) => clearTimeout(handle),
      });
      if (!ownsChrome()) return;
      if (reloaded.kind !== "value" || reloaded.value.servedFromCache) {
        setNotice(STALE_LISTING_MESSAGE);
      } else if (result.message !== undefined && result.undo !== undefined) {
        nextToastId.current += 1;
        setToasts([{ id: `op-${nextToastId.current}`, message: result.message, undo: result.undo }]);
        setNotice(null);
      } else if (result.message !== undefined) {
        setNotice(result.message);
      } else {
        setNotice(null);
      }
    })();
    return true;
  }, [epoch, options.canEdit, refresh, workspaceId, workspaceGenerationRef, listingsRef, nextToastId,
    offlineRef, operationRun, setBusy, setNotice, setToasts]);
  return { run };
}
export type RunOperationValues = ReturnType<typeof useRunOperation>;
