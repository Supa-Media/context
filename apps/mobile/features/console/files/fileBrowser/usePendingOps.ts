/**
 * The queue's pending operations as rows see them, and answering one.
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
import { useCallback, useEffect, useMemo } from "react";
import { localPathOf, opsOf } from "../../../offline/outbox";
import { foldersToRefresh } from "../tree";
import { pendingMarks } from "../pendingMarks";
import type { BrowserStateValues } from "./useBrowserState";
import type { ListingsValues } from "./useListings";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { OpenNoteValues } from "./useOpenNote";

type PendingOpsDeps =
  & Pick<BrowserStateValues, "selectedPathRef">
  & Pick<OfflineQueueValues, "listingsRef" | "offline" | "offlineRef">
  & Pick<ListingsValues, "refresh" | "reportRefreshFailure">
  & Pick<OpenNoteValues, "select">;

export function usePendingOps(deps: PendingOpsDeps) {
  const {
    listingsRef, offline, offlineRef, refresh, reportRefreshFailure, select, selectedPathRef,
  } = deps;

  /*
    Which rows the lists mark, from the queue this browser holds — the open
    context's, which is the only context any of those lists draws. Memoised on
    the queue itself so a keystroke that does not touch the queue does not hand
    every row a new selector.
  */
  const pending = useMemo(
    () =>
      pendingMarks(offline.outbox.writes, {
        ops: opsOf(offline.outbox),
        localPathOf: (path) => localPathOf(offline.outbox, path),
        creates: new Set(
          offline.outbox.writes.filter((write) => write.baseEtag === null).map((write) => write.path),
        ),
      }),
    [offline.outbox],
  );

  /*
    A drain that sent a new note or an op changed what the bucket lists, and
    the overlay stops drawing each thing the moment it leaves the queue — so the
    folders it touched are read again, or a note created offline blinks out of
    the tree until something else reloads it. Only those folders, and only ones
    the browser holds or that certainly changed.
  */
  const lastDrain = offline.lastDrain;
  useEffect(() => {
    if (lastDrain === null) return;
    const touched = [
      ...lastDrain.sent.filter((sent) => sent.sentBaseEtag === null).map((sent) => sent.path),
      ...lastDrain.ops.done.flatMap((done) => (done.to === undefined ? [done.path] : [done.path, done.to])),
    ];
    if (touched.length === 0) return;
    void refresh(foldersToRefresh(touched, { loaded: Object.keys(listingsRef.current) })).catch(
      reportRefreshFailure,
    );
  }, [lastDrain, refresh, reportRefreshFailure]);

  /**
   * A person's answer to a parked op, from the sync sheet. See `OpRow.answers`.
   * The answers are the queue's; what this adds is the editor following a
   * rename that was taken back, so the open note is not left at a name the
   * note no longer has on this device.
   */
  const answerOp = useCallback(
    (id: string, answer: "override" | "retry" | "discard") => {
      const offline = offlineRef.current;
      const op = opsOf(offline.outbox).find((one) => one.id === id);
      if (op === undefined) return;
      if (answer === "discard") {
        offline.dropOp(id);
        if (op.kind === "move" && op.to !== undefined && selectedPathRef.current === op.to) {
          select(localPathOf({ ...offline.outbox, ops: opsOf(offline.outbox).filter((one) => one.id !== id) }, op.path));
        }
        return;
      }
      if (answer === "override") offline.overrideOp(id);
      else offline.retryOp(id);
      offline.drain();
    },
    [select],
  );

  return { pending, answerOp };
}

export type PendingOpsValues = ReturnType<typeof usePendingOps>;
