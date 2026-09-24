/**
 * Deciding when an operation waits in the offline queue, and saying so.
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
import { isMarkdown } from "../paths";
import { findEntry } from "../tree";
import type { BrowserStateValues } from "./useBrowserState";
import type { OfflineQueueValues } from "./useOfflineQueue";

type QueuedOpsDeps =
  & Pick<BrowserStateValues, "editorRef" | "nextToastId" | "setNotice" | "setToasts">
  & Pick<OfflineQueueValues, "listings" | "offlineRef">;

export function useQueuedOps(deps: QueuedOpsDeps) {
  const { editorRef, listings, nextToastId, offlineRef, setNotice, setToasts } = deps;

  /* ---------------------- offline: more than saving ---------------------- */

  /**
   * Whether an operation on `path` goes into the queue rather than to the
   * bucket: always offline, and online for a note the bucket does not have at
   * that name yet (`routesThroughQueue`). Decided from the signal, never by
   * trying and waiting — see `run`.
   */
  const viaQueue = useCallback(
    (path: string) =>
      offlineRef.current.reachability === "offline" || offlineRef.current.routesThroughQueue(path),
    [],
  );

  /**
   * The version of a note this device holds, for an op to be checked against:
   * the open editor's if the note is open (what the person is looking at), the
   * mirror's otherwise. `null` when it has neither — and then the op is refused
   * locally rather than sent unchecked.
   */
  const deviceEtag = useCallback(async (path: string): Promise<string | null> => {
    const shown = editorRef.current;
    if (shown.path === path && shown.etag !== null) return shown.etag;
    const offline = offlineRef.current;
    const copy = await offline.cachedNote(offline.serverPathOf(path));
    return copy?.value.etag ?? null;
  }, []);

  /** A toast for something queued, with its undo — or with none once it has gone. */
  const queuedToast = useCallback((message: string, undo?: () => boolean, afterUndo?: () => void) => {
    nextToastId.current += 1;
    setToasts([
      {
        id: `queued-${nextToastId.current}`,
        message,
        ...(undo === undefined
          ? {}
          : {
              undo: () => {
                if (undo()) {
                  afterUndo?.();
                  return;
                }
                setNotice("That has already gone to your bucket, so it cannot be undone here.");
              },
            }),
      },
    ]);
    // A drain that is possible now goes now — online, a note renamed or
    // created here is queued only to keep its order.
    if (offlineRef.current.reachability !== "offline") offlineRef.current.drain();
  }, []);

  /**
   * Is this a folder, as the console draws it? The listing says when it knows,
   * and the path's shape when it does not — a note is `.md` by construction.
   */
  const isFolderPath = useCallback(
    (path: string) => {
      const known = findEntry(listings, path);
      return known === null ? !isMarkdown(path) : known.kind === "folder";
    },
    [listings],
  );

  return { viaQueue, deviceEtag, queuedToast, isFolderPath };
}

export type QueuedOpsValues = ReturnType<typeof useQueuedOps>;
