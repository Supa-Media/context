import { MeetingGatewayError, type MeetingsGateway } from "./gateway";
import {
  ackStep,
  classifySyncFailure,
  markSyncFailed,
  markSyncRejected,
  pendingSteps,
  type MeetingRecord,
  type SyncStep,
} from "./record";
import type { MeetingEvent } from "./protocol";

/**
 * Emptying the device into the gateway.
 *
 * `features/offline/sync.ts` with a different payload, and the three properties
 * that file argues for are the same three here, because the reasons are:
 *
 * **Sequential, and stops early on a transient failure.** Each request is a
 * round trip against the customer's own gateway on their quota, and firing a
 * meeting's four steps in parallel to be quick with somebody else's resources
 * is not a trade this product makes. Stopping is what keeps one dropped
 * connection from charging six records with a failure none of them had.
 *
 * **A rejected record is parked rather than retried.** Only `unavailable` and
 * `conflict` are transient (`classifySyncFailure` says why), and an unknown
 * refusal is parked with its sentence, undoable in one press.
 *
 * **Nothing is dropped.** A record that will not send stays on the device with
 * its explanation. The only thing that removes a meeting is a person.
 *
 * ## What is different, and it is the interesting half
 *
 * A note is one write; a meeting is four idempotent upserts that have to go in
 * order (`pendingSteps` says which and why). So a drain can get *part* of a
 * meeting through, and that partial progress is worth keeping: the segments
 * that landed are acknowledged even when the finalize behind them fails, so the
 * retry sends what is actually missing rather than the whole meeting again.
 * Without that, a meeting that fails on its last step re-uploads its entire
 * transcript on every reconnection.
 *
 * `applyEvents` is the other direction — what the gateway tells the client — so
 * that a finalize's answer becomes `written` and `enhanced` events applied
 * through the same reducer as everything else. There is no second path by which
 * a session's state changes.
 */

export interface DrainDeps {
  gateway: MeetingsGateway;
  now: () => number;
  /**
   * Called with the events a step's answer produced, so the controller folds
   * them through `applyMeetingEvent` like any other event. A drain that wrote
   * `notePath` onto the record directly would be a second reducer.
   */
  onEvents?: (meetingId: string, events: MeetingEvent[]) => void;
}

export interface MeetingDrainReport {
  /** Records that have nothing left to send. */
  synced: string[];
  /** Records parked for a person. */
  rejected: string[];
  /** Stopped before the end because something might work next time. */
  stoppedEarly: boolean;
}

export const EMPTY_MEETING_REPORT: MeetingDrainReport = Object.freeze({
  synced: [],
  rejected: [],
  stoppedEarly: false,
});

/**
 * Send everything waiting, oldest meeting first.
 *
 * Oldest first because a meeting that has been waiting since this morning is
 * the one somebody is missing, and because the order the report reads in should
 * be the order things happened.
 */
export async function drainMeetings(
  records: readonly MeetingRecord[],
  deps: DrainDeps,
): Promise<{ records: MeetingRecord[]; report: MeetingDrainReport }> {
  const out: MeetingRecord[] = [];
  const synced: string[] = [];
  const rejected: string[] = [];
  let stoppedEarly = false;

  const queue = [...records].sort(
    (a, b) => Date.parse(a.session.startedAt) - Date.parse(b.session.startedAt),
  );

  for (const record of queue) {
    if (stoppedEarly || record.rejection !== undefined) {
      out.push(record);
      continue;
    }

    const { record: after, outcome } = await sendOne(record, deps);
    out.push(after);

    if (outcome === "synced") {
      synced.push(record.session.id);
      continue;
    }
    if (outcome === "rejected") {
      rejected.push(record.session.id);
      // Deliberately keeps going: a refusal is about *this* meeting, and the
      // others behind it have nothing to do with it.
      continue;
    }
    // Transient. Whatever this ran into is almost certainly still happening.
    stoppedEarly = true;
  }

  return { records: out, report: { synced, rejected, stoppedEarly } };
}

/** One meeting, one step at a time, keeping whatever progress it makes. */
async function sendOne(
  record: MeetingRecord,
  deps: DrainDeps,
): Promise<{ record: MeetingRecord; outcome: "synced" | "rejected" | "failed" }> {
  let current = record;

  for (const step of pendingSteps(record)) {
    try {
      const { events, folderRejected } = await run(current, step, deps);
      current = ackStep(current, step, deps.now());
      /*
        Carried on the record rather than folded as an event, because it is not
        one: the contract's events are things a client observed about the
        meeting, and this is the gateway answering a question about the
        *request*. It sits beside `acked` for the same reason `acked` is there —
        this device's knowledge of a call it made.
      */
      if (folderRejected) current = { ...current, folderRejected: true };
      if (events.length > 0) deps.onEvents?.(current.session.id, events);
    } catch (error) {
      const outcome = classifySyncFailure(asGatewayError(error));
      if (outcome.kind === "rejected") {
        return {
          record: markSyncRejected(current, outcome, deps.now()),
          outcome: "rejected",
        };
      }
      const failed = markSyncFailed(current, outcome.message, deps.now());
      return { record: failed, outcome: failed.rejection ? "rejected" : "failed" };
    }
  }

  return { record: current, outcome: "synced" };
}

/**
 * Perform one step, and translate the gateway's answer into events.
 *
 * Only `finalize` produces any: it is the one call whose answer contains
 * something the client did not already know — where the note landed in the
 * customer's bucket. Everything else is an acknowledgement, and inventing an
 * event for it would put the same fact in the log twice.
 *
 * `folderRejected` comes back beside them rather than as one of them, because
 * it is not a fact about the meeting. See `sendOne`.
 *
 * **Every call is addressed to the record's own destination**, never to the
 * device's current preference. They are different things kept in different
 * places for this reason: a meeting finalized after a later one has been
 * started must go where *it* was sent, and reading what this device last chose
 * would file it wherever somebody happened to send the meeting after it.
 */
async function run(
  record: MeetingRecord,
  step: SyncStep,
  deps: DrainDeps,
): Promise<{ events: MeetingEvent[]; folderRejected?: boolean }> {
  const id = record.session.id;
  const to = record.destination;
  if (step.kind === "session") {
    await deps.gateway.putSession(to, record.session);
    return { events: [] };
  }
  if (step.kind === "segments") {
    await deps.gateway.putSegments(to, id, step.segments);
    return { events: [] };
  }
  if (step.kind === "notes") {
    await deps.gateway.putNotes(to, id, step.markdown);
    return { events: [] };
  }

  const ack = await deps.gateway.finalize(to, id);
  /*
    `IngestAck.folderRejected` says the folder this meeting named is not where
    the note is — refused as a key, or already claimed by an earlier finalize.
    The contract's own note on the field says why reading it is not optional:
    "without it the destination control would be back to appearing to work and
    doing nothing". It was set by the gateway and read by nobody, so a person
    who picked a folder and got the inbox was told nothing at all.
  */
  const folderRejected = ack.folderRejected === true;
  if (ack.notePath === null) {
    /*
      Finalize accepted but no path came back. That is the gateway saying "I
      have it, the bucket does not yet" — a real state while an enhancement runs
      — and it must not be drawn as saved. The record keeps `finalizing`; the
      next drain asks again, and `pendingSteps` will not re-finalize because
      `acked.finalized` is now true, so the answer arrives through the list.
    */
    return { events: [], folderRejected };
  }
  return { events: [{ type: "written", notePath: ack.notePath }], folderRejected };
}

function asGatewayError(error: unknown): { code: string; message: string } {
  if (error instanceof MeetingGatewayError) return { code: error.code, message: error.message };
  /*
    Anything else is a bug in this app rather than an answer from the gateway —
    a `TypeError` in a step, a store that threw. It is classified as unknown so
    it *parks* rather than retrying: a defect retried on every reconnection is
    the failure mode `classifySyncFailure`'s allowlist exists to avoid, and it
    reaches the person as a sentence rather than as silence.
  */
  return {
    code: "UNKNOWN",
    message: error instanceof Error ? error.message : "Something went wrong sending this meeting.",
  };
}
