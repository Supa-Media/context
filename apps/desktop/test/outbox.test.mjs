/**
 * A meeting recorded in a tunnel is a meeting that still lands.
 *
 * The queue is the whole offline story, so these checks are mostly about the
 * ways a naive queue loses somebody's words:
 *
 *  - a finalize that overtakes its own segments writes a note with half a
 *    transcript in it, and the gateway then answers every later attempt with
 *    the path it already wrote;
 *  - a retry that mints new segment ids duplicates every line of a two-hour
 *    meeting recorded on a train;
 *  - a queue that drops entries to stay small drops the only copy of something
 *    that was said in a room.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/core/sync/outbox.ts` and reverted:
 *
 *   `queueWrite` replacing segments instead of merging them                    7
 *   `applyDrain` deleting a parked entry rather than parking it                6
 *   `isRetryable` returning true for `meeting_forbidden`                       2
 *   `nextDrain` returning the oldest entry rather than the session's head      1
 *   the collapse resetting `attempts` on a parked entry                        1
 *
 * The two large numbers are the two that lose somebody's words, and both of
 * them originally *crashed* this file rather than failing it — a deleted entry
 * makes every later `entries[0].body` a TypeError. The reads are optional-
 * chained now, so the checks that own each failure get to report it.
 */

import { ERRORS } from "@context/meetings/protocol";
import {
  applyDrain,
  backoffMs,
  emptyOutbox,
  forgetSession,
  isRetryable,
  mergeSegments,
  nextDrain,
  normalizeOutbox,
  pendingFor,
  queueWrite,
} from "../src/core/sync/outbox.ts";
import { isMeetingId, newMeetingId } from "@context/meetings";

const seg = (id, startMs, text) => ({
  id,
  startMs,
  endMs: startMs + 1000,
  text,
  speaker: null,
  channel: "mixed",
  confidence: null,
});

export function runOutboxChecks(check) {
  const sessionId = "mtg_abcdefghjkmnpqrstvwx";

  // -- ids -------------------------------------------------------------------
  let allValid = true;
  for (let i = 0; i < 200; i += 1) {
    if (!isMeetingId(newMeetingId())) allValid = false;
  }
  check("every generated id satisfies the contract's pattern", allValid);
  check("ids are not all the same", newMeetingId() !== newMeetingId());
  const deterministic = newMeetingId((n) => new Uint8Array(n));
  check("a deterministic id is still a legal id", isMeetingId(deterministic));

  // -- ordering --------------------------------------------------------------
  {
    let outbox = emptyOutbox();
    outbox = queueWrite(outbox, { sessionId, kind: "finalize", body: { sessionId }, now: 1 });
    outbox = queueWrite(outbox, { sessionId, kind: "segments", body: { sessionId, segments: [seg("a", 0, "one")] }, now: 2 });
    outbox = queueWrite(outbox, { sessionId, kind: "session", body: { id: sessionId }, now: 3 });
    outbox = queueWrite(outbox, { sessionId, kind: "notes", body: { sessionId, notes: "hi" }, now: 4 });

    const order = [];
    let cursor = outbox;
    for (let i = 0; i < 4; i += 1) {
      const entry = nextDrain(cursor, 100);
      order.push(entry.kind);
      cursor = applyDrain(cursor, entry.id, { ok: true }, 100);
    }
    check(
      "a session drains session, segments, notes, finalize — in that order",
      order.join(",") === "session,segments,notes,finalize",
    );
    check("an emptied queue has nothing to drain", nextDrain(cursor, 100) === null);
  }

  // -- collapsing ------------------------------------------------------------
  {
    let outbox = emptyOutbox();
    for (let i = 0; i < 40; i += 1) {
      outbox = queueWrite(outbox, { sessionId, kind: "notes", body: { sessionId, notes: `draft ${i}` }, now: i });
    }
    check("forty edits are one queued write", outbox.entries.length === 1);
    check("the last edit wins", outbox.entries[0]?.body.notes === "draft 39");
  }

  {
    let outbox = emptyOutbox();
    outbox = queueWrite(outbox, { sessionId, kind: "segments", body: { sessionId, segments: [seg("s2", 1000, "two")] }, now: 1 });
    outbox = queueWrite(outbox, { sessionId, kind: "segments", body: { sessionId, segments: [seg("s1", 0, "one")] }, now: 2 });
    outbox = queueWrite(outbox, { sessionId, kind: "segments", body: { sessionId, segments: [seg("s1", 0, "one, corrected")] }, now: 3 });
    const segments = outbox.entries[0]?.body.segments ?? [];
    check("segments merge rather than replace", segments.length === 2);
    check("segments are ordered by start time", segments[0]?.id === "s1" && segments[1]?.id === "s2");
    check("a re-sent segment id replaces rather than duplicates", segments[0]?.text === "one, corrected");
    check(
      "merging is idempotent",
      mergeSegments(segments, segments).length === 2,
    );
  }

  // -- retries ---------------------------------------------------------------
  {
    check("storage being down is retryable", isRetryable(ERRORS.unavailable));
    check("a conditional-write conflict is retryable", isRetryable(ERRORS.conflict));
    check("a malformed body is not retried", !isRetryable(ERRORS.invalid));
    check("a forbidden grant is not retried", !isRetryable(ERRORS.forbidden));
    check("an unknown code is retried rather than dropped", isRetryable("something_new"));

    check("backoff grows", backoffMs(1) < backoffMs(3));
    check("backoff is capped", backoffMs(50) === 60_000);

    let outbox = queueWrite(emptyOutbox(), { sessionId, kind: "session", body: { id: sessionId }, now: 0 });
    const entry = nextDrain(outbox, 0);
    outbox = applyDrain(outbox, entry.id, { ok: false, code: ERRORS.unavailable, message: "down", retryable: true }, 0);
    check("a failed entry stays queued", outbox.entries.length === 1);
    check("a failed entry is not attempted immediately", nextDrain(outbox, 0) === null);
    check("a failed entry is attempted after its backoff", nextDrain(outbox, 60_000) !== null);
    check("the failure is recorded for the person who asks", outbox.entries[0]?.lastError === "down");
  }

  // -- parking ---------------------------------------------------------------
  {
    let outbox = queueWrite(emptyOutbox(), {
      sessionId,
      kind: "segments",
      body: { sessionId, segments: [seg("s1", 0, "something that was said in a room")] },
      now: 0,
    });
    const entry = nextDrain(outbox, 0);
    outbox = applyDrain(outbox, entry.id, { ok: false, code: ERRORS.forbidden, message: "no", retryable: false }, 0);
    check("a refusal that retrying cannot fix parks the entry", outbox.entries[0]?.state === "parked");
    check("a parked entry is NOT deleted", outbox.entries.length === 1);
    check("the transcript is still there", outbox.entries[0]?.body.segments?.[0]?.text.includes("said in a room"));
    check("a parked entry is not drained", nextDrain(outbox, 10_000_000) === null);
    check("the park reason is kept", outbox.entries[0]?.parked?.code === ERRORS.forbidden);

    // New content does not un-park it.
    const before = outbox.entries[0]?.attempts;
    outbox = queueWrite(outbox, { sessionId, kind: "segments", body: { sessionId, segments: [seg("s2", 1000, "more")] }, now: 5 });
    check("more content still merges into a parked entry", outbox.entries[0]?.body.segments?.length === 2);
    check("more content does not un-park it", outbox.entries[0]?.state === "parked" && outbox.entries[0]?.attempts === before);
  }

  // -- one session's problem is not another's --------------------------------
  {
    const other = "mtg_zyxwvtsrqpnmkjhgfedc";
    let outbox = emptyOutbox();
    outbox = queueWrite(outbox, { sessionId, kind: "session", body: { id: sessionId }, now: 0 });
    outbox = queueWrite(outbox, { sessionId: other, kind: "session", body: { id: other }, now: 1 });
    const stuck = nextDrain(outbox, 10);
    outbox = applyDrain(outbox, stuck.id, { ok: false, code: ERRORS.forbidden, message: "no", retryable: false }, 10);
    const next = nextDrain(outbox, 10);
    check("a parked session does not block another session", next !== null && next.sessionId === other);
  }

  // -- persistence -----------------------------------------------------------
  {
    let outbox = queueWrite(emptyOutbox(), { sessionId, kind: "session", body: { id: sessionId }, now: 0 });
    const round = normalizeOutbox(JSON.parse(JSON.stringify(outbox)));
    check("a queue survives a round trip through disk", round.entries.length === 1);
    check("a corrupt queue file becomes an empty queue", normalizeOutbox("nonsense").entries.length === 0);
    check("a queue from another version is not trusted", normalizeOutbox({ version: 9, entries: [1] }).entries.length === 0);
    check("garbage entries are dropped, real ones kept", normalizeOutbox({ version: 1, entries: [null, outbox.entries[0]] }).entries.length === 1);
    check("pendingFor finds a session's work", pendingFor(outbox, sessionId).length === 1);
    check("forgetting a session is the only way content leaves", forgetSession(outbox, sessionId).entries.length === 0);
  }
}
