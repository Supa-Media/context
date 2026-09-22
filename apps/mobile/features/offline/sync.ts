import {
  drainUnits,
  findOp,
  markConflict,
  markFailed,
  markOpConflict,
  markOpFailed,
  markOpRejected,
  markRejected,
  opsOf,
  rebaseOp,
  settle,
  settleOp,
  type OpKind,
  type Outbox,
  type PendingOp,
  type PendingWrite,
} from "./outbox";
import type { ConflictCheck, FileError } from "../console/files/types";

/**
 * Emptying the queue into the bucket.
 *
 * The write itself is injected, so this module contains no Convex, no React and
 * no network — which is what lets the cases that only ever happen in production
 * be ordinary tests: an etag that moved while the phone was in a pocket, a
 * bucket that answers with a failure halfway through, a queue reloaded from
 * disk after the app was killed.
 *
 * ## Why it is sequential, and why it stops early
 *
 * Each entry is one round trip against **the customer's** bucket, on their
 * request quota. Firing forty in parallel to be quick with somebody else's
 * resources is not a trade this product gets to make. Sequential also makes the outcome
 * explicable: the report reads in the order things were typed.
 *
 * A transient failure stops the whole drain rather than continuing down the
 * list. The overwhelmingly likely cause is that the connection went away again
 * mid-drain, and marching on turns one failure into a whole queue of entries
 * carrying failure counts for a problem none of them had.
 *
 * ## What it will not do
 *
 * It never sends a `conflicted` or `rejected` entry, never rewrites `baseEtag`,
 * and never calls `write` without whatever `expectedEtag` the entry was typed
 * against. Those three together are the reason a drain cannot silently
 * overwrite somebody: every write it makes is the same conflict-checked write
 * the online Save button makes, with the same server-side check, degrading to
 * `read-compare` on exactly the buckets it degrades on when you are online.
 */

/**
 * How many times a transient failure may be retried before it is parked.
 *
 * Counted per entry across *reconnections*, not within one drain — a drain
 * stops at the first transient failure, so reaching this takes six separate
 * occasions on which the app believed it was online and the bucket disagreed.
 * At that point "it will go through next time" has stopped being true, and
 * saying so beats a queue that retries silently forever against somebody's
 * paid-for request quota.
 */
export const MAX_ATTEMPTS = 6;

/** What one attempted write did. Returned rather than thrown, so it is data. */
export type WriteOutcome =
  | { kind: "written"; etag: string; conflictCheck: ConflictCheck }
  /** The note moved on. `currentEtag` absent means it was deleted. */
  | { kind: "conflict"; currentEtag?: string; message: string }
  /** Refused for a reason retrying will not change. */
  | { kind: "rejected"; code: string; message: string }
  /** Something went wrong that might not next time. */
  | { kind: "failed"; message: string };

/**
 * Failure codes worth trying again, and the reason this is an allowlist.
 *
 * The other direction — "these codes are permanent, everything else retries" —
 * fails in the expensive direction: a code this file has not heard of (a new
 * one, a permission refusal, a workspace that was revoked) would be retried on
 * every reconnection forever, against a customer's bucket, for a request that
 * was never going to succeed. Unknown therefore means *parked and reported*,
 * which a person can undo with one press, rather than *retried and silent*,
 * which nobody can see.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  // "Your bucket did not complete that request." — the control plane's own
  // wrapper for an adapter throw.
  "STORAGE_FAILED",
  // `toFileError`'s fallback. A dropped socket unwraps to this.
  "UNKNOWN",
  // Somebody else is mid-CAS on privacy.md. Genuinely a "try again".
  "PRIVACY_MANIFEST_BUSY",
]);

/**
 * Turn what `writeNote` threw into an outcome.
 *
 * Takes the already-unwrapped `FileError` from `browser.ts`'s `toFileError`
 * rather than the raw throw, so there is exactly one place in the app that
 * decides what a thrown thing is allowed to say on somebody's screen — and this
 * is not a second one.
 */
/**
 * What one queued rename, move, archive, delete or new folder did.
 *
 * The failure halves are `WriteOutcome`'s, classified by the same allowlist,
 * because an op meets the same bucket with the same failure modes. `etag` is
 * the note's version where the op left it — a move's new path — which the
 * next op on that note is sent against.
 */
export type OpOutcome =
  | { kind: "done"; etag?: string; to?: string }
  | Exclude<WriteOutcome, { kind: "written" }>;

export function classifyOpFailure(error: FileError): OpOutcome {
  const outcome = classifyWriteFailure(error);
  // `classifyWriteFailure` never answers `written`; the narrowing is for the compiler.
  return outcome.kind === "written" ? { kind: "done" } : outcome;
}

export function classifyWriteFailure(error: FileError): WriteOutcome {
  if (error.code === "CONFLICT") {
    return { kind: "conflict", currentEtag: error.currentEtag, message: error.message };
  }
  if (TRANSIENT_CODES.has(error.code)) {
    return { kind: "failed", message: error.message };
  }
  return { kind: "rejected", code: error.code, message: error.message };
}

export interface DrainDeps {
  write: (write: PendingWrite) => Promise<WriteOutcome>;
  /** Leave writes owned by another persistence protocol queued. */
  shouldWrite?: (write: PendingWrite) => boolean;
  /**
   * Sends one op. Optional so a caller that has only edits to send — a test of
   * the edit half — need not invent one; without it ops are left exactly as
   * they are, never dropped.
   */
  op?: (op: PendingOp) => Promise<OpOutcome>;
  /** Called after each op the bucket accepted, so the device's copy can follow it. */
  onOpDone?: (done: OpSent) => void;
  now: () => number;
  /**
   * Called after each entry that reached the server successfully, so the cache
   * and any open editor can move onto the etag the bucket now holds. A drain
   * that left the editor on a stale etag would make the person's *next* save a
   * conflict against their own write.
   */
  onWritten?: (result: { path: string; etag: string; conflictCheck: ConflictCheck }) => void;
}

/** One write that reached the bucket. */
export interface Sent {
  path: string;
  /** The etag the bucket now holds for it. */
  etag: string;
  conflictCheck: ConflictCheck;
  /**
   * The entry's `updatedAt` at the moment it was sent.
   *
   * Here because a drain is asynchronous and a person keeps typing through it.
   * A caller reconciling the result against the live queue needs to know
   * *which version* went, or it drops an edit made mid-drain.
   */
  sentUpdatedAt: number;
  /**
   * The version the write was checked against. A caller reconciling with the
   * live queue moves an op queued mid-drain onto what this write produced —
   * but only an op asked about the same version, which this is how to tell.
   */
  sentBaseEtag: string | null;
}

/** One op that reached the bucket. */
export interface OpSent {
  id: string;
  kind: OpKind;
  path: string;
  /** For a move: where the note is now. */
  to?: string;
  /** The note's version where the op left it, when the server said. */
  etag?: string;
  /** The op's `updatedAt` when it went — see `Sent.sentUpdatedAt`. */
  sentUpdatedAt: number;
}

export interface DrainReport {
  sent: Sent[];
  conflicted: string[];
  rejected: string[];
  /** Ops, by id. Separate from the edits, whose lists are paths. */
  ops: { done: OpSent[]; conflicted: string[]; rejected: string[] };
  /** Stopped before the end because a write failed in a way that may recover. */
  stoppedEarly: boolean;
}

export const EMPTY_REPORT: DrainReport = {
  sent: [],
  conflicted: [],
  rejected: [],
  ops: { done: [], conflicted: [], rejected: [] },
  stoppedEarly: false,
};

const EXHAUSTED_MESSAGE =
  "This has failed to reach your bucket several times. It is still here — try it again, or open the note and copy what you need.";

export async function drainOutbox(
  outbox: Outbox,
  deps: DrainDeps,
): Promise<{ outbox: Outbox; report: DrainReport }> {
  let current = outbox;
  const sent: DrainReport["sent"] = [];
  const conflicted: string[] = [];
  const rejected: string[] = [];
  const ops: DrainReport["ops"] = { done: [], conflicted: [], rejected: [] };
  let stoppedEarly = false;

  /*
    Snapshotted before the loop: `current` is replaced on every step, and
    re-deriving the list each time would re-read entries this drain has already
    settled. Anything queued *during* the drain waits for the next one, which
    is the honest ordering — it was typed after we started sending.

    One note at a time (`drainUnits`): its edit, then whatever was asked of it.
    A note whose edit is parked or refused has its op held back with it — a
    rename sent past a parked edit would carry the bucket's text under the new
    name and leave the person's text parked at a path that no longer exists.
    Held back is not charged: nothing reached the bucket.
  */
  units: for (const unit of drainUnits(outbox)) {
    let held = false;
    const write = unit.write;
    if (write !== undefined) {
      if (deps.shouldWrite !== undefined && !deps.shouldWrite(write)) continue;
      if (write.state !== "pending") {
        held = true;
      } else {
        const outcome = await deps.write(write);

        if (outcome.kind === "written") {
          current = settle(current, write.path);
          sent.push({
            path: write.path,
            etag: outcome.etag,
            conflictCheck: outcome.conflictCheck,
            sentUpdatedAt: write.updatedAt,
            sentBaseEtag: write.baseEtag,
          });
          deps.onWritten?.({
            path: write.path,
            etag: outcome.etag,
            conflictCheck: outcome.conflictCheck,
          });
          /*
            The op on this note follows the version this edit produced — if it
            was asked about the version the edit was typed on (or had none yet,
            because the edit is the note's create). An op asked about some
            other version keeps it, and is refused or not on its own merits.
          */
          const op = unit.op === undefined ? undefined : findOp(current, unit.op.id);
          if (op !== undefined && (op.baseEtag === null || op.baseEtag === write.baseEtag)) {
            current = rebaseOp(current, op.id, outcome.etag);
          }
        } else if (outcome.kind === "conflict") {
          current = markConflict(current, write.path, {
            currentEtag: outcome.currentEtag,
            message: outcome.message,
            now: deps.now(),
          });
          conflicted.push(write.path);
          // Deliberately keeps going. A conflict is about *this note*, and the
          // other forty in the queue have nothing to do with it — stopping here
          // would hold back writes that would have gone through.
          held = true;
        } else if (outcome.kind === "rejected") {
          current = markRejected(current, write.path, {
            code: outcome.code,
            message: outcome.message,
            now: deps.now(),
          });
          rejected.push(write.path);
          held = true;
        } else {
          // Transient. One more attempt spent; park it if that was the last one.
          // The two branches are exclusive because both `markFailed` and
          // `markRejected` count the attempt, and running them in sequence would
          // charge this one write twice.
          if (write.attempts + 1 >= MAX_ATTEMPTS) {
            current = markRejected(current, write.path, {
              code: "RETRIES_EXHAUSTED",
              message: EXHAUSTED_MESSAGE,
              now: deps.now(),
            });
            rejected.push(write.path);
          } else {
            current = markFailed(current, write.path, outcome.message);
          }
          // Stops either way: whatever this write ran into is almost certainly
          // still happening to the entries behind it.
          stoppedEarly = true;
          break units;
        }
      }
    }

    if (unit.op === undefined || held || deps.op === undefined) continue;
    const op = findOp(current, unit.op.id);
    if (op === undefined || op.state !== "pending") continue;

    if (op.kind !== "folder" && op.baseEtag === null) {
      /*
        Waiting on a version this queue has yet to produce. If something ahead
        of it still can — an edit on this note, a rename landing on it — it
        waits, uncharged. If nothing can, it never will, and it says so rather
        than sitting in the queue forever or, worse, being sent unconditionally.
      */
      if (!canStillSupply(current, op)) {
        current = markOpRejected(current, op.id, {
          code: "NOTHING_TO_ACT_ON",
          message: ORPHANED_MESSAGE,
          now: deps.now(),
        });
        ops.rejected.push(op.id);
      }
      continue;
    }

    const outcome = await deps.op(op);
    if (outcome.kind === "done") {
      current = settleOp(current, op.id);
      const done: OpSent = {
        id: op.id,
        kind: op.kind,
        path: op.path,
        ...(op.to === undefined ? {} : { to: op.to }),
        ...(outcome.etag === undefined ? {} : { etag: outcome.etag }),
        sentUpdatedAt: op.updatedAt,
      };
      ops.done.push(done);
      deps.onOpDone?.(done);
      /*
        A rename of this rename, queued behind it while it was in flight, has
        been waiting for exactly this: the note's version at its new name.
      */
      if (op.kind === "move" && op.to !== undefined && outcome.etag !== undefined) {
        const next = opsOf(current).find((one) => one.path === op.to && one.baseEtag === null);
        if (next !== undefined) current = rebaseOp(current, next.id, outcome.etag);
      }
      continue;
    }
    if (outcome.kind === "conflict") {
      current = markOpConflict(current, op.id, {
        currentEtag: outcome.currentEtag,
        message: outcome.message,
        now: deps.now(),
      });
      ops.conflicted.push(op.id);
      continue;
    }
    if (outcome.kind === "rejected") {
      current = markOpRejected(current, op.id, {
        code: outcome.code,
        message: outcome.message,
        now: deps.now(),
      });
      ops.rejected.push(op.id);
      continue;
    }
    if (op.attempts + 1 >= MAX_ATTEMPTS) {
      current = markOpRejected(current, op.id, {
        code: "RETRIES_EXHAUSTED",
        message: EXHAUSTED_MESSAGE,
        now: deps.now(),
      });
      ops.rejected.push(op.id);
    } else {
      current = markOpFailed(current, op.id, outcome.message);
    }
    stoppedEarly = true;
    break;
  }

  return { outbox: current, report: { sent, conflicted, rejected, ops, stoppedEarly } };
}

const ORPHANED_MESSAGE =
  "What this was waiting on was taken back, so there is nothing left for it to act on. Discard it.";

/**
 * Whether anything still in the queue can give a versionless op its version:
 * an edit of the same note (its create, typically), or a rename landing on it.
 */
function canStillSupply(outbox: Outbox, op: PendingOp): boolean {
  if (outbox.writes.some((write) => write.path === op.path)) return true;
  return opsOf(outbox).some((other) => other.id !== op.id && other.kind === "move" && other.to === op.path);
}
