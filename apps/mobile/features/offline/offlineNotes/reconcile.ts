import {
  find,
  findOp,
  opsOf,
  settle,
  type Outbox,
  type PendingOp,
  type PendingWrite,
} from "../outbox";
import type { DrainReport } from "../sync";

/*
  How a finished drain is folded back over the live queue, and the local op
  ids it mints. Moved out of `useOfflineNotes.ts`, which re-exports
  `reconcile` for its tests; nothing here touches React.
*/

/** A local handle for an op. Never sent, so it only has to be unique on this device. */
export function newOpId(): string {
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Fold a finished drain's result back over whatever the queue looks like now.
 *
 * A drain is asynchronous and a person keeps typing through it, so the queue
 * the drain started from is not the queue that exists when it finishes. `live`
 * is now, `drained` is what the drain decided, `report` says which version of
 * each entry actually went.
 *
 * Three cases, and each of them is a bug if collapsed into another:
 *
 *  - **Sent, and nothing typed since** (`updatedAt <= sentUpdatedAt`): drop it.
 *  - **Sent, and typed since**: keep the newer text, and **re-base it onto the
 *    etag the drain just wrote**. Without that re-base the person's next drain
 *    conflicts them against their own write of thirty seconds ago, which is the
 *    most confusing conflict it is possible to show somebody.
 *  - **Not sent**: take the drain's verdict — the conflict, the refusal, the
 *    attempt count — because those are facts about the bucket that newer typing
 *    does not change. The text stays whatever is live.
 *
 * `exported for its own test` rather than inlined: this is the one piece of the
 * offline layer whose bug would be invisible (an edit silently dropped, or a
 * self-conflict a minute later) and it is unreachable through the hook without
 * a fake timer race.
 */
export function reconcile(
  live: Outbox,
  drained: Outbox,
  report: DrainReport,
  /** For the one op reconciling can add — see the inverse move below. */
  make: { id: () => string; now: number } = { id: newOpId, now: Date.now() },
): Outbox {
  let result = live;

  for (const entry of live.writes) {
    const sent = report.sent.find((one) => one.path === entry.path);

    if (sent !== undefined) {
      if (entry.updatedAt <= sent.sentUpdatedAt) {
        result = settle(result, entry.path);
      } else {
        result = patch(result, entry.path, { baseEtag: sent.etag, state: "pending" });
      }
      continue;
    }

    const after = find(drained, entry.path);
    if (after === undefined) continue;
    result = patch(result, entry.path, {
      state: after.state,
      attempts: after.attempts,
      baseEtag: after.baseEtag,
      conflict: after.conflict,
      rejection: after.rejection,
      lastError: after.lastError,
    });
  }

  return reconcileOps(result, drained, report, make);
}

/**
 * The same fold for ops, which have one case the edits do not.
 *
 * Ops are never rewritten while a drain runs (`coalesce` is off), so an op the
 * drain sent is exactly the op still in the live queue — it goes. An op the
 * drain reached a verdict on takes that verdict, and its re-based version with
 * it. An op queued *during* the drain was not in the snapshot, so nothing
 * re-based it; it is moved here onto what the drain's landings produced, by
 * the same rule the drain uses (`rebaseOp`) — the edit it followed, or the
 * rename it was queued behind.
 *
 * **And an op the person took back while it was on the wire.** The undo that
 * could do that refuses during a drain, but "Discard" on a parked op in the
 * sheet is always a drop, and a `dropOp` racing a send is possible. The bucket
 * has done it; the person's last word was "don't". For a rename that is
 * answered by queueing the rename back, at the version the rename returned —
 * a real, conditional op the person can see. A delete or archive that landed
 * cannot be taken back from here and is not pretended to have been.
 */
function reconcileOps(
  live: Outbox,
  drained: Outbox,
  report: DrainReport,
  make: { id: () => string; now: number },
): Outbox {
  const done = new Map(report.ops.done.map((one) => [one.id, one]));
  const ops: PendingOp[] = [];
  for (const op of opsOf(live)) {
    if (done.has(op.id)) continue;
    const after = findOp(drained, op.id);
    if (after !== undefined) {
      ops.push({
        ...op,
        state: after.state,
        attempts: after.attempts,
        baseEtag: after.baseEtag,
        conflict: after.conflict,
        rejection: after.rejection,
        lastError: after.lastError,
      });
      continue;
    }
    ops.push(rebasedOnLandings(op, report));
  }

  for (const landed of report.ops.done) {
    if (landed.kind !== "move" || landed.to === undefined) continue;
    // Sent from the snapshot and gone from the live queue: dropped mid-flight.
    if (opsOf(live).some((op) => op.id === landed.id)) continue;
    if (landed.etag === undefined) continue;
    ops.push({
      id: make.id(),
      kind: "move",
      path: landed.to,
      to: landed.path,
      baseEtag: landed.etag,
      queuedAt: make.now,
      updatedAt: make.now,
      state: "pending",
      attempts: 0,
    });
  }
  return { ...live, ops };
}

function rebasedOnLandings(op: PendingOp, report: DrainReport): PendingOp {
  const edit = report.sent.find((one) => one.path === op.path);
  if (edit !== undefined && (op.baseEtag === null || op.baseEtag === edit.sentBaseEtag)) {
    return { ...op, baseEtag: edit.etag };
  }
  if (op.baseEtag === null) {
    const rename = report.ops.done.find(
      (one) => one.kind === "move" && one.to === op.path && one.etag !== undefined,
    );
    if (rename?.etag !== undefined) return { ...op, baseEtag: rename.etag };
  }
  return op;
}

function patch(outbox: Outbox, path: string, fields: Partial<PendingWrite>): Outbox {
  return {
    ...outbox,
    writes: outbox.writes.map((write) =>
      write.path === path ? { ...write, ...fields } : write,
    ),
  };
}
