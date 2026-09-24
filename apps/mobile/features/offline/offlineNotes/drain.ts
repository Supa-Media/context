import type { Dispatch, SetStateAction } from "react";
import { isEmpty, localPathOf, type Outbox, type PendingOp, type PendingWrite } from "../outbox";
import { drainOutbox, type DrainReport, type OpOutcome, type OpSent, type WriteOutcome } from "../sync";
import type { OpenNote, Visibility } from "../../console/files/types";
import { newOpId, reconcile } from "./reconcile";

/** Everything `useOfflineNotes`'s `drain` reads, handed in from the hook. */
export interface DrainInputs {
  workspaceId: string | null;
  mine: () => boolean;
  commit: (next: Outbox, immediate: boolean) => void;
  rememberCreated: (note: OpenNote) => void;
  rememberOpDone: (done: OpSent) => void;
  rememberSent: (body: { path: string; text: string; etag: string }) => void;
  setLastDrain: Dispatch<SetStateAction<DrainReport | null>>;
  draining: { current: boolean };
  outboxRef: { readonly current: Outbox };
  writeRef: { readonly current: (write: PendingWrite) => Promise<WriteOutcome> };
  shouldWriteRef: { readonly current: ((write: PendingWrite) => boolean) | undefined };
  opRef: { readonly current: ((op: PendingOp) => Promise<OpOutcome>) | undefined };
  onWrittenRef: {
    readonly current: ((result: { path: string; etag: string; shownAt?: string }) => void) | undefined;
  };
  onOpDoneRef: { readonly current: ((done: OpSent) => void) | undefined };
  folderDefaultRef: { readonly current: ((path: string) => Visibility) | undefined };
  collaborationOwnedRef: { readonly current: Set<string> };
}

/**
 * One pass at emptying the live queue: the body of `useOfflineNotes`'s `drain`,
 * which keeps its `useCallback` and dependency list. The refs are read when
 * this runs, exactly as the callback read them.
 */
export function drainLiveQueue({
  workspaceId,
  mine,
  commit,
  rememberCreated,
  rememberOpDone,
  rememberSent,
  setLastDrain,
  draining,
  outboxRef,
  writeRef,
  shouldWriteRef,
  opRef,
  onWrittenRef,
  onOpDoneRef,
  folderDefaultRef,
  collaborationOwnedRef,
}: DrainInputs): void {
  /*
    Not a device write, and gated anyway. The console stays mounted through
    `await signOut()`, and this fires from an effect the moment a queue and a
    connection exist — so a reconnection inside that window would send the
    queue the person was just told had been discarded, to the bucket, under a
    session that is ending.

    It is still not a cancellation: a drain already in flight finishes, and
    what the epoch stops is anything it would write back to this device.
  */
  if (draining.current || workspaceId === null || !mine()) return;
  const current = outboxRef.current;
  if (isEmpty(current)) return;
  draining.current = true;

  const send = opRef.current;
  void drainOutbox(current, {
    write: (write) => writeRef.current(write),
    shouldWrite: (write) => !collaborationOwnedRef.current.has(write.path) && (shouldWriteRef.current?.(write) ?? true),
    ...(send === undefined ? {} : { op: (op: PendingOp) => send(op) }),
    now: () => Date.now(),
    onOpDone: (done) => {
      rememberOpDone(done);
    },
  })
    .then(({ outbox: next, report }) => {
      /*
        Anything queued *while* the drain was running is in `outboxRef` and
        not in `next`, which was derived from the snapshot the drain started
        with. Re-applying the drain's result over the newer state — rather
        than replacing it — is what stops a save made mid-drain from being
        silently dropped.
      */
      // Keep aliases before completed moves leave the queue. The editor may
      // already show the destination while this write used the source name.
      const shownPaths = new Map(report.sent.map((sent) => [
        sent.path, localPathOf(outboxRef.current, sent.path),
      ]));
      commit(
        reconcile(outboxRef.current, next, report, { id: newOpId, now: Date.now() }),
        true,
      );
      // Reconcile first. The editor needs to know whether a newer write was
      // queued while this request was in flight before it marks a create
      // settled or upgrades it to a canonical collaboration generation.
      for (const sent of report.sent) {
        onWrittenRef.current?.({ path: sent.path, etag: sent.etag, shownAt: shownPaths.get(sent.path) });
      }
      // Writes land before moves. Deliver their acknowledgements in that
      // order so a move can advance the version the write just established.
      for (const done of report.ops.done) onOpDoneRef.current?.(done);
      setLastDrain(report);
      /*
        What was sent is in the bucket now, at the etag the write returned,
        so the device's copy moves onto it — the same thing a Save that lands
        does (`rememberBody`). Without it, an edit made offline and drained
        reads back offline as the version it replaced until the next sync.
      */
      for (const sent of report.sent) {
        const entry = current.writes.find((write) => write.path === sent.path);
        if (entry === undefined) continue;
        if (sent.sentBaseEtag === null) {
          /*
            A note created offline is in the bucket now, and in nothing on
            the device: the queue has let it go and the mirror never held it,
            so the tree drawn offline would lose it until the next sync
            fetched it. It goes into the mirror as what was written, drawn
            with its folder's default for a badge — the next complete sync
            replaces that with the server's own answer.
          */
          const visibility = folderDefaultRef.current?.(sent.path) ?? "private";
          rememberCreated({
            path: sent.path,
            text: entry.text,
            etag: sent.etag,
            visibility,
            inherited: visibility,
            exception: false,
            readOnly: false,
          });
          continue;
        }
        rememberSent({ path: sent.path, text: entry.text, etag: sent.etag });
      }
    })
    .catch(() => {
      // `drainOutbox` does not throw; an injected `write` that rejects rather
      // than resolving an outcome would land here. The queue is untouched, so
      // the next reconnection tries again.
    })
    .finally(() => {
      draining.current = false;
    });
}
