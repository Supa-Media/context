import {
  drainable,
  markConflict,
  markFailed,
  markRejected,
  settle,
  type Outbox,
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
 * request quota, and each one snapshots a `.history/` object into **their**
 * storage. Firing forty in parallel to be quick with somebody else's resources
 * is not a trade this product gets to make. Sequential also makes the outcome
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
  now: () => number;
  /**
   * Called after each entry that reached the server successfully, so the cache
   * and any open editor can move onto the etag the bucket now holds. A drain
   * that left the editor on a stale etag would make the person's *next* save a
   * conflict against their own write.
   */
  onWritten?: (result: { path: string; etag: string; conflictCheck: ConflictCheck }) => void;
}

export interface DrainReport {
  sent: { path: string; etag: string; conflictCheck: ConflictCheck }[];
  conflicted: string[];
  rejected: string[];
  /** Stopped before the end because a write failed in a way that may recover. */
  stoppedEarly: boolean;
}

export const EMPTY_REPORT: DrainReport = {
  sent: [],
  conflicted: [],
  rejected: [],
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
  let stoppedEarly = false;

  // Snapshotted before the loop: `current` is replaced on every step, and
  // re-deriving the list each time would re-read entries this drain has already
  // settled. Anything queued *during* the drain waits for the next one, which
  // is the honest ordering — it was typed after we started sending.
  for (const write of drainable(outbox)) {
    const outcome = await deps.write(write);

    if (outcome.kind === "written") {
      current = settle(current, write.path);
      sent.push({ path: write.path, etag: outcome.etag, conflictCheck: outcome.conflictCheck });
      deps.onWritten?.({
        path: write.path,
        etag: outcome.etag,
        conflictCheck: outcome.conflictCheck,
      });
      continue;
    }

    if (outcome.kind === "conflict") {
      current = markConflict(current, write.path, {
        currentEtag: outcome.currentEtag,
        message: outcome.message,
        now: deps.now(),
      });
      conflicted.push(write.path);
      // Deliberately keeps going. A conflict is about *this note*, and the
      // other forty in the queue have nothing to do with it — stopping here
      // would hold back writes that would have gone through.
      continue;
    }

    if (outcome.kind === "rejected") {
      current = markRejected(current, write.path, {
        code: outcome.code,
        message: outcome.message,
        now: deps.now(),
      });
      rejected.push(write.path);
      continue;
    }

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
    // Stops either way: whatever this write ran into is almost certainly still
    // happening to the entries behind it.
    stoppedEarly = true;
    break;
  }

  return { outbox: current, report: { sent, conflicted, rejected, stoppedEarly } };
}
