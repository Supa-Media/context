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
 *   the drain assigning its snapshot over the live queue again                 4
 *   an entry that gained content mid-flight deleted by the old ack             1
 *   a refusal forgotten because the content changed                            1
 *
 * The three new rows are one defect with three faces, and it is the one that
 * loses somebody's words *after* they were told the write was accepted: a drain
 * is a snapshot plus a round trip, the queue does not stand still for it, and
 * `outbox = report.outbox` in `main/index.ts` dropped everything queued in
 * between. `reconcileDrain` is the answer and these are what it must not stop
 * doing.
 *
 * The two large numbers are the two that lose somebody's words, and both of
 * them originally *crashed* this file rather than failing it — a deleted entry
 * makes every later `entries[0].body` a TypeError. The reads are optional-
 * chained now, so the checks that own each failure get to report it.
 *
 * `recoverStaleFinalize`'s own sabotage, against the owner's "stuck on
 * Finalizing for two hours" bug report:
 *
 *   the `retry` branch removed (every stale sighting goes straight to fail)   4
 *   the stale finalize entry not dropped after a `fail` is queued for it      1
 *
 * `selectionRank`'s own sabotage — a `session`/`finalize` head jumping a deep
 * backlog rather than riding `nextDrain`'s plain `queuedAt` order, the fix for
 * the residual `docs/decisions/desktop.md` measured at 74/75 queued entries.
 * Counts are whole-suite, because `sessionOrder.test.mjs` carries the driven
 * half of the same guard and both move together:
 *
 *   `nextDrain` sorting by `queuedAt` alone again (no priority)              10
 *   the backoff arm of the readiness filter removed                          4
 *   the parked arm of the readiness filter removed                           3
 */

import { ERRORS } from "@context/meetings/protocol";
import { FINALIZE_TIMEOUT_MS } from "@context/meetings/recovery";
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
  dropMisaddressed,
  misaddressedSegments,
  queueWrite,
  reconcileDrain,
  recoverStaleFinalize,
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

  // -- one meeting's words never ride in another meeting's write -------------
  //
  // The queue was innocent and is the choke point anyway. Every desktop enqueue
  // goes through `queueWrite` — the tray's controller and the console's
  // `writeMeetingFromConsole` — so the rule lives here rather than in two
  // callers, one of which a third caller will not copy. What it stops is the
  // defect that parked eight of the owner's meetings: a leaked recorder
  // subscription in the console app handed a finished meeting the *next*
  // meeting's transcript, correctly stamped with the id of the meeting it came
  // from and addressed to a meeting it did not.
  {
    const other = "mtg_zyxwvtsrqpnmkjhgfedc";
    let outbox = emptyOutbox();
    outbox = queueWrite(outbox, {
      sessionId,
      kind: "segments",
      body: { segments: [seg(`${other}-mic-0-s000`, 0, "spoken in another meeting")] },
      now: 1,
    });
    check(
      "a batch minted for another meeting is not queued under this one",
      outbox.entries[0]?.body.segments.length === 0,
    );
    check(
      "and the two meetings are named, so something can say what happened",
      misaddressedSegments(sessionId, { segments: [seg(`${other}-mic-0-s000`, 0, "x")] }).join() === other,
    );

    outbox = queueWrite(outbox, {
      sessionId,
      kind: "segments",
      body: {
        segments: [
          seg(`${sessionId}-mic-0-s000`, 0, "mine"),
          seg(`${other}-mic-1-s000`, 1000, "not mine"),
        ],
      },
      now: 2,
    });
    const kept = outbox.entries[0]?.body.segments ?? [];
    check(
      "a mixed batch keeps this meeting's rows and drops the rest",
      kept.length === 1 && kept[0].id === `${sessionId}-mic-0-s000`,
    );

    /*
      The phone's recorders key their chunks on `String(Date.now())`, so their
      ids name no meeting. Unaddressed is not misaddressed, and dropping those
      would be this queue quietly losing a whole client's transcripts.
    */
    outbox = queueWrite(outbox, {
      sessionId,
      kind: "segments",
      body: { segments: [seg("1757280000000-0-s000", 2000, "from a phone")] },
      now: 3,
    });
    check(
      "a segment id that names no meeting is still queued",
      (outbox.entries[0]?.body.segments ?? []).length === 2,
    );
    check(
      "and a batch that names nobody else reports nothing",
      misaddressedSegments(sessionId, { segments: [seg("1757280000000-0-s000", 0, "x")] }).length === 0,
    );
  }

  // -- and a queue written by an older build is cleaned once, on the way in ---
  //
  // The eight entries that were actually on the owner's machine: parked, each
  // holding a later meeting's transcript. Parking is terminal in this app, so
  // they get no further enqueue for `queueWrite` to clean them up on — without
  // this pass they would hold another meeting's words for the life of the
  // machine, and the meetings they hang off would keep reporting a refusal
  // about words that are missing from nothing.
  {
    const other = "mtg_zyxwvtsrqpnmkjhgfedc";
    const stale = {
      version: 1,
      entries: [
        {
          id: `${sessionId}:segments`,
          sessionId,
          kind: "segments",
          body: { segments: [seg(`${other}-mic-0-s000`, 0, "another meeting")] },
          queuedAt: 0,
          updatedAt: 0,
          attempts: 1,
          state: "parked",
          parked: { code: ERRORS.invalid, message: "gateway answered 400", noticedAt: 0 },
          nextAttemptAt: 0,
        },
        {
          id: "mtg_bbbbbbbbbbbbbbbbbbbb:segments",
          sessionId: "mtg_bbbbbbbbbbbbbbbbbbbb",
          kind: "segments",
          body: {
            segments: [
              seg("mtg_bbbbbbbbbbbbbbbbbbbb-mic-0-s000", 0, "mine"),
              seg(`${other}-mic-1-s000`, 1000, "not mine"),
            ],
          },
          queuedAt: 0,
          updatedAt: 0,
          attempts: 1,
          state: "parked",
          nextAttemptAt: 0,
        },
        {
          id: `${sessionId}:finalize`,
          sessionId,
          kind: "finalize",
          body: { endedAt: new Date().toISOString() },
          queuedAt: 0,
          updatedAt: 0,
          attempts: 0,
          state: "pending",
          nextAttemptAt: 0,
        },
      ],
    };

    const purged = dropMisaddressed(stale);
    check("every misaddressed row is counted", purged.dropped === 2);
    check(
      "an entry holding nothing of its own meeting is dropped whole",
      !purged.outbox.entries.some((entry) => entry.id === `${sessionId}:segments`),
    );
    const mixed = purged.outbox.entries.find((entry) => entry.id === "mtg_bbbbbbbbbbbbbbbbbbbb:segments");
    check(
      "an entry with some of its own rows keeps exactly those",
      mixed.body.segments.length === 1 && mixed.body.segments[0].id.startsWith("mtg_bbbbbbbbbbbbbbbbbbbb"),
    );
    check(
      "...and stays parked, because removing content does not make a refusal acceptable",
      mixed.state === "parked" && mixed.attempts === 1,
    );
    check(
      "nothing that is not a segments entry is touched",
      purged.outbox.entries.some((entry) => entry.kind === "finalize"),
    );
    check(
      "a queue with nothing misaddressed in it is left alone",
      dropMisaddressed(purged.outbox).dropped === 0 &&
        dropMisaddressed(purged.outbox).outbox.entries.length === purged.outbox.entries.length,
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

  // -- a session or finalize jumps the queue, at any depth --------------------
  //
  // The residual an adversarial review measured against the arithmetic fix
  // alone (`drainUrgency("session") === "now"`): a pass carries at most 25
  // entries, so a `session` write queued behind a backlog deeper than that
  // still rode `nextDrain`'s plain `queuedAt` order and missed the pass it
  // needed. `docs/decisions/desktop.md`'s table measured a transcript through
  // 74 queued entries ahead of it and none at 75. This is the fix the reviewer
  // named: the selection `nextDrain` makes, not the persisted order of the
  // queue — nothing here is moved, only picked first.
  {
    let outbox = emptyOutbox();
    for (let i = 0; i < 120; i += 1) {
      outbox = queueWrite(outbox, {
        sessionId: `mtg_backlog${i}`,
        kind: "notes",
        body: { notes: "an earlier, unrelated meeting" },
        now: i,
      });
    }
    // Queued strictly after all 120 lower-urgency heads above, so an ordering
    // that fell back to `queuedAt` would put it dead last.
    outbox = queueWrite(outbox, { sessionId, kind: "session", body: { id: sessionId }, now: 1000 });

    check(
      "A SESSION ROW JUMPS A QUEUE OF ANY DEPTH — not merely one deeper than the reviewer measured",
      nextDrain(outbox, 1000)?.id === `${sessionId}:session`,
    );

    // The jump moves nothing: once it drains, the backlog resumes exactly
    // where it left off.
    outbox = applyDrain(outbox, `${sessionId}:session`, { ok: true }, 1000);
    check(
      "...and the backlog is untouched by the jump — the oldest entry is still next",
      nextDrain(outbox, 1000)?.id === "mtg_backlog0:notes",
    );
  }

  {
    let outbox = emptyOutbox();
    for (let i = 0; i < 120; i += 1) {
      outbox = queueWrite(outbox, {
        sessionId: `mtg_backlog2_${i}`,
        kind: "segments",
        body: { sessionId: `mtg_backlog2_${i}`, segments: [] },
        now: i,
      });
    }
    outbox = queueWrite(outbox, {
      sessionId,
      kind: "finalize",
      body: { sessionId, endedAt: new Date(2000).toISOString() },
      now: 2000,
    });
    check(
      "A FINALIZE JUMPS THE QUEUE THE SAME WAY A SESSION ROW DOES — it is already awaited by its caller",
      nextDrain(outbox, 2000)?.id === `${sessionId}:finalize`,
    );
  }

  // The jump is a selection rule, never a reorder: a session's own writes
  // still come out in contract order, even threaded through a hundred-entry
  // backlog of *other* sessions that are free to interleave between them —
  // only `session` and `finalize` outrank that backlog, so this session's own
  // `segments` legitimately waits its turn behind older `notes` heads exactly
  // as it would have before this change. What must not happen is this
  // session's own three entries arriving out of their own relative order.
  {
    let outbox = emptyOutbox();
    for (let i = 0; i < 100; i += 1) {
      outbox = queueWrite(outbox, { sessionId: `mtg_other${i}`, kind: "notes", body: { notes: "x" }, now: i });
    }
    outbox = queueWrite(outbox, { sessionId, kind: "finalize", body: { sessionId }, now: 500 });
    outbox = queueWrite(outbox, {
      sessionId,
      kind: "segments",
      body: { sessionId, segments: [seg("s1", 0, "one")] },
      now: 500,
    });
    outbox = queueWrite(outbox, { sessionId, kind: "session", body: { id: sessionId }, now: 500 });

    const order = [];
    let cursor = outbox;
    for (let i = 0; i < 103; i += 1) {
      const entry = nextDrain(cursor, 500);
      if (entry === null) break;
      if (entry.sessionId === sessionId) order.push(entry.kind);
      cursor = applyDrain(cursor, entry.id, { ok: true }, 500);
    }
    check(
      "JUMPING THE QUEUE DOES NOT REORDER A SESSION'S OWN WRITES — session, then segments, then finalize",
      order.join(",") === "session,segments,finalize",
    );
    check(
      "...and the session row still jumped ahead of every one of the hundred older backlog heads",
      order[0] === "session",
    );
  }

  // -- a permanently failing high-urgency entry does not starve the rest -----
  //
  // The jump must not become a new way to get stuck. A parked or backed-off
  // head is excluded from `nextDrain`'s ready set the same way any other head
  // is — the priority is over *what is ready*, never a reason to wait on
  // something that is not.
  {
    let outbox = queueWrite(emptyOutbox(), {
      sessionId,
      kind: "notes",
      body: { notes: "behind a permanently refused session" },
      now: 0,
    });
    outbox = queueWrite(outbox, { sessionId: "mtg_stuck", kind: "session", body: { id: "mtg_stuck" }, now: 1 });
    outbox = applyDrain(
      outbox,
      "mtg_stuck:session",
      { ok: false, code: ERRORS.forbidden, message: "no", retryable: false },
      1,
    );
    check(
      "A PARKED HIGH-URGENCY ENTRY DOES NOT BLOCK A LOWER-URGENCY ONE FOREVER",
      nextDrain(outbox, 1)?.id === `${sessionId}:notes`,
    );
  }
  {
    let outbox = queueWrite(emptyOutbox(), {
      sessionId,
      kind: "notes",
      body: { notes: "behind a session that is retrying" },
      now: 0,
    });
    outbox = queueWrite(outbox, { sessionId: "mtg_retrying", kind: "session", body: { id: "mtg_retrying" }, now: 1 });
    outbox = applyDrain(
      outbox,
      "mtg_retrying:session",
      { ok: false, code: ERRORS.unavailable, message: "down", retryable: true },
      1,
    );
    check(
      "A BACKED-OFF HIGH-URGENCY ENTRY DOES NOT BLOCK A LOWER-URGENCY ONE EITHER",
      nextDrain(outbox, 1)?.id === `${sessionId}:notes`,
    );
  }

  // -- a drain does not freeze the queue --------------------------------------

  /**
   * THE QUEUE MOVES WHILE A DRAIN IS IN FLIGHT, AND NOTHING QUEUED THEN IS LOST.
   *
   * A drain is a snapshot plus a network round trip. During it a segment is
   * spoken, somebody types in the notepad, the console hands over a write — all
   * synchronous, all landing on the live queue. `main/index.ts` used to assign
   * the drain's result over the top (`outbox = report.outbox`), which drops
   * every one of them, and the dropped write has already been answered as
   * accepted: on the console path `meetings.write` said `queued: true` about a
   * note the queue no longer holds. That is the false acknowledgement
   * `app-and-console.md` forbids by name.
   */
  {
    const before = queueWrite(emptyOutbox(), {
      sessionId,
      kind: "segments",
      body: { sessionId, segments: [seg("s1", 0, "one")] },
      now: 0,
    });
    // The drain sent it and the gateway said yes.
    const drained = applyDrain(before, before.entries[0].id, { ok: true }, 10);
    // Meanwhile the person typed, and the console handed the notes over.
    const live = queueWrite(before, { sessionId, kind: "notes", body: { markdown: "typed" }, now: 5 });

    const next = reconcileDrain(before, drained, live);
    check(
      "A WRITE QUEUED DURING A DRAIN SURVIVES IT — it was acknowledged to somebody",
      next.entries.some((entry) => entry.kind === "notes" && entry.body.markdown === "typed"),
    );
    check(
      "...and what the gateway did acknowledge is gone",
      !next.entries.some((entry) => entry.kind === "segments"),
    );
  }

  {
    const before = queueWrite(emptyOutbox(), {
      sessionId,
      kind: "segments",
      body: { sessionId, segments: [seg("s1", 0, "one")] },
      now: 0,
    });
    const drained = applyDrain(before, before.entries[0].id, { ok: true }, 10);
    // Two more segments merged into the same entry while its predecessor was in
    // flight. What the gateway acknowledged is not what the queue is holding.
    const live = queueWrite(before, {
      sessionId,
      kind: "segments",
      body: { sessionId, segments: [seg("s2", 1000, "two")] },
      now: 5,
    });

    const next = reconcileDrain(before, drained, live);
    check(
      "AN ENTRY THAT GAINED CONTENT MID-FLIGHT IS NOT DELETED BY THE OLD ACK",
      next.entries[0]?.kind === "segments" && next.entries[0]?.body.segments?.length === 2,
    );
  }

  {
    const before = queueWrite(emptyOutbox(), { sessionId, kind: "session", body: { id: sessionId }, now: 0 });
    const drained = applyDrain(
      before,
      before.entries[0].id,
      { ok: false, code: ERRORS.forbidden, message: "no", retryable: false },
      10,
    );
    const live = queueWrite(before, { sessionId, kind: "session", body: { id: sessionId, title: "later" }, now: 5 });

    const next = reconcileDrain(before, drained, live);
    check(
      "a refusal is about the meeting, so it survives the content changing",
      next.entries[0]?.state === "parked" && next.entries[0]?.parked?.code === ERRORS.forbidden,
    );
    check(
      "...and the newer content is what is kept beside it",
      next.entries[0]?.body.title === "later",
    );
  }

  {
    const before = queueWrite(emptyOutbox(), { sessionId, kind: "session", body: { id: sessionId }, now: 0 });
    const drained = applyDrain(before, before.entries[0].id, { ok: true }, 10);
    check(
      "a queue nothing touched during the drain is the drain's own answer",
      reconcileDrain(before, drained, before).entries.length === 0,
    );
  }

  {
    const before = queueWrite(emptyOutbox(), { sessionId, kind: "session", body: { id: sessionId }, now: 0 });
    const drained = applyDrain(
      before,
      before.entries[0].id,
      { ok: false, code: ERRORS.unavailable, message: "offline", retryable: true },
      10,
    );
    // A person deleted the meeting while the request was in the air.
    const next = reconcileDrain(before, drained, forgetSession(before, sessionId));
    check(
      "a meeting somebody deleted mid-drain stays deleted",
      next.entries.length === 0,
    );
  }

  // -- a stuck finalize is not left stuck forever -----------------------------
  //
  // The pure rule (`checkFinalizeTimeout`, `packages/meetings/src/recovery.js`)
  // is tested with its own fake clock in `packages/meetings/test/recovery.test.mjs`.
  // What is checked here is the glue: that a stale `finalize` entry in *this*
  // queue is retried once and then turned into a queued `fail`, never simply
  // read again forever.
  {
    const endedAt = "2026-09-07T10:00:00.000Z";
    const T0 = Date.parse(endedAt);
    const finalizing = queueWrite(emptyOutbox(), {
      sessionId,
      kind: "finalize",
      body: { sessionId, endedAt },
      now: T0,
    });

    check(
      "a finalize entry well within the bound is left alone",
      recoverStaleFinalize(finalizing, T0 + 1_000).entries[0].retriedAt === undefined,
    );

    const retried = recoverStaleFinalize(finalizing, T0 + FINALIZE_TIMEOUT_MS);
    check(
      "at the bound, the entry is stamped retried and put back at the front of the queue",
      retried.entries.length === 1 &&
        retried.entries[0].retriedAt === T0 + FINALIZE_TIMEOUT_MS &&
        retried.entries[0].state === "pending" &&
        retried.entries[0].nextAttemptAt === T0 + FINALIZE_TIMEOUT_MS &&
        retried.entries[0].attempts === 0,
    );
    check(
      "...and it is still the one entry nextDrain offers",
      nextDrain(retried, T0 + FINALIZE_TIMEOUT_MS)?.kind === "finalize",
    );

    check(
      "asking again well inside the retry's own window changes nothing further",
      recoverStaleFinalize(retried, T0 + FINALIZE_TIMEOUT_MS + 1_000).entries[0].retriedAt ===
        T0 + FINALIZE_TIMEOUT_MS,
    );

    const failedAt = T0 + FINALIZE_TIMEOUT_MS * 2;
    const failed = recoverStaleFinalize(retried, failedAt);
    check(
      "a full timeout window past the retry, the stale finalize is dropped",
      !failed.entries.some((entry) => entry.kind === "finalize"),
    );
    const failEntry = failed.entries.find((entry) => entry.kind === "session");
    check(
      "...and a `session` write carrying a `fail` event is queued in its place",
      failEntry !== undefined &&
        Array.isArray(failEntry.body.events) &&
        failEntry.body.events[0]?.type === "fail" &&
        failEntry.body.events[0]?.at === new Date(failedAt).toISOString() &&
        typeof failEntry.body.events[0]?.reason === "string",
    );
    check(
      "...addressed to the same context the finalize was, so a shared workspace's meeting fails there too",
      (() => {
        const addressed = queueWrite(emptyOutbox(), {
          sessionId,
          kind: "finalize",
          body: { sessionId, endedAt },
          context: "acme",
          now: T0,
        });
        const afterRetry = recoverStaleFinalize(addressed, T0 + FINALIZE_TIMEOUT_MS);
        const afterFail = recoverStaleFinalize(afterRetry, T0 + FINALIZE_TIMEOUT_MS * 2);
        return afterFail.entries.find((entry) => entry.kind === "session")?.context === "acme";
      })(),
    );
    check(
      "a session already failed is not asked to fail again on a later pass",
      recoverStaleFinalize(failed, failedAt + FINALIZE_TIMEOUT_MS * 10).entries.length ===
        failed.entries.length,
    );

    /*
      "Retry once" has to survive the process, or a machine that crashes inside
      the retry window grants a fresh retry on every launch and never reaches
      the failure this exists to produce. `retriedAt` rides on the entry, and
      the entry is JSON on disk, so this is the round trip `main/index.ts`
      actually performs on launch — write, read back through `normalizeOutbox`,
      recover.
    */
    check(
      "the one retry survives a restart: it is on the entry, and the entry is on disk",
      (() => {
        const onDisk = normalizeOutbox(JSON.parse(JSON.stringify(retried)));
        if (onDisk.entries[0]?.retriedAt !== T0 + FINALIZE_TIMEOUT_MS) return false;
        const afterRelaunch = recoverStaleFinalize(onDisk, T0 + FINALIZE_TIMEOUT_MS * 2);
        // Failed, not retried a second time — which is what a lost `retriedAt`
        // would have produced, forever, one relaunch at a time.
        return (
          !afterRelaunch.entries.some((entry) => entry.kind === "finalize") &&
          afterRelaunch.entries.some((entry) => entry.kind === "session")
        );
      })(),
    );

    check(
      "a finalize parked on a refusal nobody looked at is recovered too, rather than parked forever",
      (() => {
        const parked = {
          ...finalizing,
          entries: finalizing.entries.map((entry) => ({
            ...entry,
            state: "parked",
            parked: { code: ERRORS.invalid, message: "nobody has looked at this", noticedAt: T0 },
          })),
        };
        const once = recoverStaleFinalize(parked, T0 + FINALIZE_TIMEOUT_MS);
        const twice = recoverStaleFinalize(once, T0 + FINALIZE_TIMEOUT_MS * 2);
        return (
          once.entries[0]?.state === "pending" &&
          !twice.entries.some((entry) => entry.kind === "finalize") &&
          twice.entries.some((entry) => entry.kind === "session")
        );
      })(),
    );

    check(
      "a finalize entry with no endedAt at all is left alone rather than failed for the wrong reason",
      (() => {
        const noEndedAt = queueWrite(emptyOutbox(), {
          sessionId,
          kind: "finalize",
          body: { sessionId },
          now: T0,
        });
        const after = recoverStaleFinalize(noEndedAt, T0 + FINALIZE_TIMEOUT_MS * 10);
        return after.entries.length === 1 && after.entries[0].kind === "finalize";
      })(),
    );

    check(
      "new content on the finalize entry restarts its own timeout clock",
      (() => {
        const stale = queueWrite(emptyOutbox(), {
          sessionId,
          kind: "finalize",
          body: { sessionId, endedAt },
          now: T0,
        });
        const stamped = recoverStaleFinalize(stale, T0 + FINALIZE_TIMEOUT_MS);
        const laterEndedAt = new Date(T0 + 60_000).toISOString();
        const reQueued = queueWrite(stamped, {
          sessionId,
          kind: "finalize",
          body: { sessionId, endedAt: laterEndedAt },
          now: T0 + FINALIZE_TIMEOUT_MS + 2_000,
        });
        return (
          reQueued.entries[0].retriedAt === undefined &&
          recoverStaleFinalize(reQueued, T0 + FINALIZE_TIMEOUT_MS + 3_000).entries[0].retriedAt ===
            undefined
        );
      })(),
    );

    check(
      "a queue with no finalize entry at all is untouched",
      (() => {
        const onlySession = queueWrite(emptyOutbox(), { sessionId, kind: "session", body: { id: sessionId }, now: T0 });
        return recoverStaleFinalize(onlySession, T0 + FINALIZE_TIMEOUT_MS * 10) === onlySession ||
          recoverStaleFinalize(onlySession, T0 + FINALIZE_TIMEOUT_MS * 10).entries.length === 1;
      })(),
    );
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
