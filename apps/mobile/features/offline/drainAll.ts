import { getOutbox, putOutbox } from "./cache";
import { parseKey } from "./keys";
import type { KeyValueStore } from "./memory";
import { counts, isEmpty, type Outbox, type PendingOp, type PendingWrite } from "./outbox";
import { drainOutbox, type OpOutcome, type OpSent, type WriteOutcome } from "./sync";

/**
 * Emptying the queues of the contexts nobody is looking at.
 *
 * ## The gap this closes
 *
 * `useOfflineNotes` hydrates and drains **one** workspace's outbox — the one
 * the console is showing — because that is the one it holds a live queue for.
 * Everything else about the queue is per-context and correct; what was missing
 * is that a reconnection only ever emptied one of them.
 *
 * So: edit a note in your own context, switch to a shared one and edit there,
 * go through a tunnel, come back. The context on screen drains. The other one
 * sits there — not lost, not corrupted, just unsent — until somebody happens to
 * navigate back into it. `waitingOnDevice` would count those writes at sign-out
 * and the status strip would say "3 notes waiting to sync", which is exactly
 * right and exactly unhelpful: the app knew, said so, and had no way to act.
 *
 * That is the closest thing in this folder to a data-loss path. The queue is
 * durable and nothing drops it, so the work survives — but "your edit will go
 * when you reconnect" was true of one context and not of the rest, and nothing
 * on screen distinguished them.
 *
 * ## Why the open context is excluded, and why that is not a hole
 *
 * The console holds a **live** queue for the context it is showing, and the
 * persisted copy of that one trails it by up to `PERSIST_DEBOUNCE_MS`. Two
 * drains against one queue — one from the live copy, one from a stale record on
 * disk — would re-send entries the other had already settled and write back a
 * queue missing whatever was typed in between.
 *
 * So this takes every queue *except* that one, and `useOfflineNotes` goes on
 * taking that one, on the same reconnection, by the path it always did. It is
 * the same split `waitingOnDevice(store, exceptQueueIn)` already makes for the
 * sign-out warning, for the same reason and with the same boundary.
 *
 * `null` means "no context is open", which is a real state — a cold start that
 * has not resolved one yet — and then every queue is this function's.
 *
 * ## What it does not change
 *
 * Every write it makes is the one `drainOutbox` already makes: the same
 * `expectedEtag` the draft was typed against, the same conflict parked rather
 * than retried, the same bounded attempts, the same allowlist of transient
 * codes. There is no second write path here and no `force` anywhere. This
 * module decides *which queues* and in *what order*; `sync.ts` decides
 * everything about what happens to a queue, and that is the whole division.
 *
 * It is also sequential across contexts for the reason `drainOutbox` is
 * sequential within one: each entry is a round trip against the customer's
 * bucket, on their request quota, and firing four contexts' queues at once to
 * be quick with somebody else's resources is not a trade this product makes.
 */

/** What one background pass did, per context. Returned rather than logged. */
export interface BackgroundDrainReport {
  workspaceId: string;
  sent: number;
  conflicted: number;
  rejected: number;
  /** Stopped before the end because a write failed in a way that may recover. */
  stoppedEarly: boolean;
}

export interface DrainAllDeps {
  /**
   * Perform one queued write, in a **named** context.
   *
   * The workspace is an argument rather than a closure, which is the one real
   * difference from the foreground drain: `useFileBrowser`'s `sendQueued` is
   * bound to the open context, and a background drain that reused it would
   * write every context's queued edits into whichever one happened to be on
   * screen. `writeNote` has always taken a `workspaceId`; this passes the one
   * the queue is filed under and never the one being looked at.
   */
  write: (workspaceId: string, write: PendingWrite) => Promise<WriteOutcome>;
  /**
   * Sends one queued rename, move, archive, delete or folder — bound, like
   * `write`, to the workspace the queue is filed under and never to the one
   * on screen. Optional: without it every op is left exactly where it was.
   */
  op?: (workspaceId: string, op: PendingOp) => Promise<OpOutcome>;
  /** An op that landed, so the device's copy can follow it. */
  onOpDone?: (workspaceId: string, done: OpSent) => void;
  now: () => number;
  /**
   * Whether this mount's session still owns the device.
   *
   * Checked before every queue and again before every write-back, because a
   * pass over four contexts spans far more time than a single drain and a
   * sign-out in the middle of it must not re-persist a queue the person was
   * warned about and chose to discard. `epoch.ts` carries the argument.
   */
  mine: () => boolean;
  /**
   * A write this pass made landed: `text` is in the bucket at `etag`, in the
   * context the queue is filed under. For the device's copy of that note to
   * move onto it — the mirror's `moveMirroredBody` — so an edit made offline
   * does not read back as the version it replaced until the next sync.
   *
   * With the workspace as an argument for the same reason `write` has one, and
   * never used for the open editor: that is what `onWritten` is for, and this
   * pass has none.
   */
  onSent?: (workspaceId: string, body: { path: string; text: string; etag: string }) => void;
}

/**
 * Every workspace that has a queue on this device, from the keys alone.
 *
 * Read off the store rather than off the context list on purpose. A queue
 * belongs to somebody's typing, and the list of contexts the console can
 * currently see is a different question that can be answered late, short, or
 * not at all — driving the drain from it would leave unsent work in a context
 * whose row had not loaded yet. A queue for a context this person has genuinely
 * lost is not a problem either: its writes are refused by the server and parked
 * by the rules that already exist, which is the honest outcome and the one a
 * person can see.
 */
export async function workspacesWithQueues(store: KeyValueStore): Promise<string[]> {
  const found = new Set<string>();
  for (const key of await store.keys()) {
    const parsed = parseKey(key);
    if (parsed?.kind === "outbox") found.add(parsed.workspaceId);
  }
  return [...found];
}

/**
 * Drain every queue on the device except the open context's.
 *
 * Never throws: it runs on a reconnection, alongside the foreground drain, and
 * a rejection here would be an unhandled one in an effect. A queue that could
 * not be read or written is left exactly as it was for the next reconnection,
 * which is what every other failure in this folder also does.
 */
export async function drainOtherContexts(
  store: KeyValueStore,
  exceptWorkspaceId: string | null,
  deps: DrainAllDeps,
): Promise<BackgroundDrainReport[]> {
  const reports: BackgroundDrainReport[] = [];

  for (const workspaceId of await workspacesWithQueues(store)) {
    if (workspaceId === exceptWorkspaceId) continue;
    if (!deps.mine()) break;

    let outbox: Outbox;
    try {
      outbox = await getOutbox(store, workspaceId);
    } catch {
      continue;
    }
    if (isEmpty(outbox)) continue;

    const sendOp = deps.op;
    const { outbox: next, report } = await drainOutbox(outbox, {
      write: (write) => deps.write(workspaceId, write),
      ...(sendOp === undefined ? {} : { op: (op: PendingOp) => sendOp(workspaceId, op) }),
      onOpDone: (done) => deps.onOpDone?.(workspaceId, done),
      now: deps.now,
      /*
        No `onWritten`. Its job is to move the **open** editor onto the etag the
        bucket now holds, and by construction none of these queues belongs to
        the open context — so there is no editor to move, and calling it would
        hand the console an etag for a note it is not showing.
      */
    });

    /*
      The write-back is guarded again rather than once at the top: a queue of
      forty entries is forty round trips, and a sign-out that happened during
      them would otherwise be undone here, one context at a time.
    */
    if (!deps.mine()) break;
    try {
      await putOutbox(store, next);
    } catch {
      // The queue on disk is still the pre-drain one, so the entries this pass
      // sent will be attempted again and refused as conflicts or settled as
      // no-ops. Both are visible; silently dropping them would not be.
      continue;
    }

    for (const sent of report.sent) {
      const entry = outbox.writes.find((write) => write.path === sent.path);
      if (entry !== undefined) {
        deps.onSent?.(workspaceId, { path: sent.path, text: entry.text, etag: sent.etag });
      }
    }

    const settled = counts(next);
    reports.push({
      workspaceId,
      sent: report.sent.length + report.ops.done.length,
      conflicted: settled.conflicted,
      rejected: settled.rejected,
      stoppedEarly: report.stoppedEarly,
    });
  }

  return reports;
}
