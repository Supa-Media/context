/**
 * The offline queue for the open context, the listings the console draws with
 * that queue laid over the bucket's, and the open note's hold on the mirror.
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
import { parentPath } from "../paths";
import { useOfflineNotes } from "../../../offline/useOfflineNotes";
import { holdAncestors, releaseAncestors } from "../../../offline/mirrorHolds";
import { useMirrorStatus } from "../../../offline/mirrorStatus";
import type { OpOutcome, OpSent } from "../../../offline/sync";
import { queuedOpSender } from "../queuedWrite";
import type { PendingOp } from "../../../offline/outbox";
import { overlayKey, overlayListings } from "../../../offline/overlay";
import type { FileBrowserOptions } from "./types";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { WritesAndImagesValues } from "./useWritesAndImages";

type OfflineQueueDeps =
  & { options: FileBrowserOptions }
  & Pick<
    FileActionsValues,
    | "archiveEntry"
    | "createDirectory"
    | "moveEntry"
    | "readNote"
    | "trashEntry"
    | "workspaceId"
  >
  & Pick<
    BrowserStateValues,
    | "bucketListings"
    | "collaborationPaths"
    | "dispatch"
    | "editor"
    | "editorRef"
    | "openRun"
  >
  & Pick<WritesAndImagesValues, "sendQueued">;

export function useOfflineQueue(deps: OfflineQueueDeps) {
  const {
    options, archiveEntry, bucketListings, collaborationPaths, createDirectory, dispatch, editor,
    editorRef, moveEntry, openRun, readNote, sendQueued, trashEntry, workspaceId,
  } = deps;

  /**
   * A drained write moves the open editor onto the etag the bucket now holds.
   *
   * Without this, the note you are looking at still carries the etag its
   * queued draft was typed against — which the drain has just superseded — and
   * your very next Save conflicts you against your own write of a moment ago.
   */
  const onDrained = useCallback((result: { path: string; etag: string; shownAt?: string }) => {
    const current = editorRef.current;
    const generation = openRun.current;
    /*
      The bucket's path, or the name this device shows it under: an edit of a
      note renamed here is sent to the note's old name, ahead of the rename,
      and the editor holding it is open at the new one.
    */
    const shownAt = result.shownAt ?? offlineRef.current.localPathOf(result.path);
    if (current.path !== result.path && current.path !== shownAt) return;
    const newer = offlineRef.current.pendingFor(result.path) !== undefined;
    if (!newer) dispatch({ type: "queueSettled", etag: result.etag });
    else dispatch({ type: "queueCanonicalized", etag: result.etag });
    if (workspaceId === null) return;
    // A create ACK may carry the legacy raw etag. Read the note through the
    // authorized file path so the editor can bind durable collaboration only
    // after the backend has initialized and advertised its c2 generation.
    const reread = (attempt: number): void => {
      void readNote({ workspaceId, path: result.path })
        .then((canonical) => {
          const open = editorRef.current;
          if (openRun.current !== generation) return;
          if (open.path !== result.path && open.path !== shownAt) return;
          // A later raw/collaboration save owns the editor now. This reread
          // must not relabel that newer text or move its etag backwards.
          if (open.etag !== result.etag) return;
          const canonicalGeneration = canonical.etag.startsWith("c2.");
          dispatch({
            type: "queueCanonicalized",
            etag: canonical.etag,
            text: canonical.text,
            // Keep the raw ACK as the historical ancestor whenever local text
            // changed during the reread. Replacing against current c2 directly
            // could overwrite peer edits already included in this response.
            ...(canonicalGeneration ? { baseEtag: result.etag } : {}),
          });
          if (!canonicalGeneration && attempt < 2) {
            const delay = [500, 1500][attempt] ?? 1500;
            setTimeout(() => {
              if (openRun.current === generation) reread(attempt + 1);
            }, delay);
          }
        })
        .catch(() => {
          if (attempt >= 2) return;
          const delay = [500, 1500][attempt] ?? 1500;
          setTimeout(() => {
            if (openRun.current === generation) reread(attempt + 1);
          }, delay);
        });
    };
    reread(0);
  }, [readNote, workspaceId]);

  /**
   * One queued rename, move, archive, delete or new folder — `queuedOpSender`,
   * bound to the context on screen exactly as `sendQueued` is, and for the same
   * reason: the background drain binds the same sender to each queue's own
   * context, and one definition is one place for the version to be required.
   */
  const sendOpTo = useMemo(
    () => queuedOpSender({ moveEntry, archiveEntry, trashEntry, createDirectory }),
    [archiveEntry, createDirectory, moveEntry, trashEntry],
  );
  const sendQueuedOp = useCallback(
    async (op: PendingOp): Promise<OpOutcome> => {
      if (workspaceId === null) return { kind: "failed", message: "No context is open." };
      return sendOpTo(workspaceId, op);
    },
    [sendOpTo, workspaceId],
  );

  /**
   * A queued rename reached the bucket: the open note follows it onto the
   * version the rename produced, so its next save is not a conflict with the
   * person's own rename. Guarded in the reducer on the version the editor was
   * holding (`rebased`).
   */
  const onOpDrained = useCallback((done: OpSent) => {
    if (done.kind !== "move" || done.etag === undefined || done.to === undefined) return;
    if (editorRef.current.path !== done.to) return;
    dispatch({ type: "rebased", from: opFromEtag.current.get(done.id) ?? null, etag: done.etag });
  }, []);
  /**
   * A tool wrote the open note, and presence has already merged the shared
   * document onto it.
   *
   * The etag moves so this client's next conditional save is checked against
   * the version the tool left rather than the one the editor opened — which
   * would otherwise be a conflict raised about a change already merged into
   * the text being saved. Everything else about the editor is untouched: the
   * draft is the merge, and it is still unsaved.
   */
  const onExternalWrite = useCallback((written: { path: string; etag: string | null }) => {
    if (written.etag === null) return;
    dispatch({ type: "externalWrite", path: written.path, etag: written.etag });
  }, []);

  /*
    **Who to tell when a save lands, and why it is a subscription.**

    A console save goes through the control plane's own file operation, not
    through the gateway's `write_note` — so the presence room has no other way
    to learn that the bucket moved, and every other member of the room keeps
    the etag their editor opened with. The moment the person who was saving
    leaves, the next one elected writes against a version two edits old and
    gets the conflict box this feature exists to delete.

    A subscription rather than a callback passed in, because the socket is
    opened from this browser's own state (`useNoteRoom` reads
    `data.files.editor.path`) — handing it back down here would be a cycle. So
    this emits, and whoever owns a room listens.
  */
  const savedListeners = useRef(new Set<(written: { path: string; etag: string }) => void>());
  const onSaved = useCallback((handler: (written: { path: string; etag: string }) => void) => {
    savedListeners.current.add(handler);
    return () => {
      savedListeners.current.delete(handler);
    };
  }, []);
  const announceSaved = useCallback((written: { path: string; etag: string }) => {
    for (const handler of [...savedListeners.current]) {
      try {
        handler(written);
      } catch {
        // A listener that throws must not fail the save that just succeeded.
      }
    }
  }, []);

  /*
    The version each op was sent with, by id — what `rebased` compares the
    editor against. Recorded as ops are sent rather than read off the queue,
    because by the time `onOpDone` runs the drain has already settled the op.
  */
  const opFromEtag = useRef(new Map<string, string | null>());
  const sendQueuedOpTracked = useCallback(
    (op: PendingOp) => {
      opFromEtag.current.set(op.id, op.baseEtag);
      return sendQueuedOp(op);
    },
    [sendQueuedOp],
  );

  const offline = useOfflineNotes({
    workspaceId,
    tier: options.tier,
    write: sendQueued,
    shouldWrite: (write) => !collaborationPaths.current.has(write.path),
    onWritten: onDrained,
    op: sendQueuedOpTracked,
    onOpDone: onOpDrained,
    folderDefaultFor: (path) => listingsRef.current[parentPath(path)]?.folderDefault ?? "private",
  });

  /*
    Read through a ref inside every callback below.

    `offline` is a fresh object whenever the queue changes — which is on every
    keystroke while offline — and a `refresh`/`select`/`save` that depended on
    it would be rebuilt just as often. `refresh` is a dependency of the effect
    that loads the root, so that is not a performance note: it is the render
    loop `consoleRenderLoop.test.ts` exists to catch. The rendered values
    (`reachability`, `counts`) come off `offline` itself; the behaviour reads
    the ref.
  */
  const offlineRef = useRef(offline);
  offlineRef.current = offline;

  /*
    The listings the console draws: the bucket's, with the queue laid over.

    Recomputed only when the queue's *shape* changes (`overlayKey` — which ops,
    which creates), never on a keystroke into a queued note: every callback
    below depends on `listings`, and rebuilding all of them per character is
    the churn `consoleRenderLoop.test.ts` watches for.
  */
  const overlayShape = useRef<{ key: string; outbox: typeof offline.outbox } | null>(null);
  const shapeKey = overlayKey(offline.outbox);
  if (overlayShape.current === null || overlayShape.current.key !== shapeKey) {
    overlayShape.current = { key: shapeKey, outbox: offline.outbox };
  }
  const shapedOutbox = overlayShape.current.outbox;
  const listings = useMemo(
    () => overlayListings(bucketListings, shapedOutbox),
    [bucketListings, shapedOutbox],
  );

  /*
    Declared here, straight after the `listings` it holds, rather than beside
    the bucket-write effect that the comment on it describes (now in
    `useVisibility.ts`). `folderDefaultFor` above and many callbacks in the
    parts after this one read it, and a part can only read what an earlier
    part has already declared.
  */
  const listingsRef = useRef(listings);
  listingsRef.current = listings;

  /** How much of this context is on the device — for `sync.mirror`. */
  const mirrorStatus = useMirrorStatus(workspaceId);

  /*
    The open note's version, held for the mirror's ancestor rule.

    A note can sit open and clean for ten minutes while a sync moves the
    device's copy on underneath it; the moment somebody then types, the draft
    is based on the version the editor opened, and a merge will need exactly
    that body. Neither the queue nor a draft names it yet, so the editor holds
    it itself (`mirrorHolds.ts`) — the etag it is showing, and the base of the
    draft it is holding, which differ once a conflict is open.
  */
  const editorHold = useRef(`editor:${Math.random().toString(36).slice(2)}`).current;
  useEffect(() => {
    holdAncestors(
      editorHold,
      workspaceId,
      editor.path === null ? {} : { [editor.path]: [editor.etag, editor.draftBase] },
    );
  }, [editor.draftBase, editor.etag, editor.path, editorHold, workspaceId]);
  useEffect(() => () => releaseAncestors(editorHold), [editorHold]);

  return {
    onExternalWrite, onSaved, announceSaved, offline, offlineRef, listings, listingsRef,
    mirrorStatus,
  };
}

export type OfflineQueueValues = ReturnType<typeof useOfflineQueue>;
